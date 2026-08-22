"use strict";

(() => {
  const SCHEMA_VERSION = "ab-empirical-2.3.0";
  const INSTRUMENT_VERSION = "study-b-2.3.5";
  const ASSIGNMENT_VERSION = "williams-counter-perm-v4";
  const DATA_ENDPOINT = "https://script.google.com/macros/s/AKfycbwlL7Q1MTGulPDKc8r3UwYq_i-_7HEUxsOQhIDPSrxn4etn1_TtG2Gcq30NfwU5xtgPgw/exec";
  // Must match completion_codes[0].code in deploy/prolific/study-b.json. The code is chosen by
  // the researcher, not issued by Prolific, so these two files are the only source of truth.
  const COMPLETION_URL = "https://app.prolific.com/submissions/complete?cc=ABSTUDYB";
  // Test hooks (?seq=, ?selected=, selftest.js) are only honoured while no
  // production collector is configured, so participants cannot use them.
  const TEST_MODE = DATA_ENDPOINT === null;
  // Stated once, shown to the participant, and checked against `estimated_completion_time` in
  // deploy/prolific/study-b.json by preflight.py. It has drifted twice: the consent screen said seven
  // minutes after the session became eight, and eight after it became nine, while the reward was
  // priced on the newer figure. A participant reading a duration the researcher no longer believes is
  // a false statement on a consent screen, and a reward priced above the stated time is the researcher
  // paying for a task they described as shorter.
  const SESSION_MINUTES = 9;
  const params = new URLSearchParams(location.search);

  // Consent facts, following the route taken by the conceptual paper's Study 1b.
  //
  // ethicsReview:
  //   "self"      — assessed by the researcher against a published standard, no external committee.
  //                 Legitimate for minimal-risk anonymous work like this, and NOT the same as
  //                 approval. The consent screen says so in plain words rather than going quiet
  //                 about it, because a participant is entitled to know who checked.
  //   "committee" — an external body reviewed it; ethicsBody and ethicsRef must then be real.
  const CONSENT = {
    researcher: "Vishi Rajvanshi",
    email: "vishirajvanshi@gmail.com",
    ethicsReview: "self",
    selfAssessment: "ethics/SELF-ASSESSMENT-STUDY-B.md",
    ethicsBody: null,          // committee route only
    ethicsRef: null,           // committee route only
    // UK participants means UK GDPR. The controller is whoever decides how the data is used; with
    // no institution behind the study that is the named researcher personally.
    controller: "Vishi Rajvanshi, acting in a personal capacity",
    retention: "5 years from collection, then deleted",
    withdrawalDays: 14,
    // Named at the level a participant can act on. Deliberately does NOT claim a region: a consumer
    // Google account gives no guarantee of where Google processes the data, and inventing
    // "EU region" on the consent screen would be a false assurance. See
    // ethics/SELF-ASSESSMENT-STUDY-B.md for the transfer position.
    storedWhere: "a private Google Sheet in the researcher's Google Drive"
  };

  // What is still missing before a participant may see this page. Which fields are required depends
  // on the route: the committee fields are irrelevant under self-assessment, and demanding them
  // there would be the software insisting on a fiction.
  function consentGaps() {
    const required = CONSENT.ethicsReview === "committee"
      ? ["researcher", "email", "ethicsBody", "ethicsRef", "controller", "retention", "storedWhere"]
      : ["researcher", "email", "selfAssessment", "controller", "retention", "storedWhere"];
    return required.filter(key => CONSENT[key] === null || CONSENT[key] === "");
  }

  // Recruitment channel. "pilot" is friends, family, and anyone the researcher can identify; those
  // records are quarantined out of the confirmatory sample by unique_usable() in common.py. Absent
  // means "prolific", so the confirmatory default is what you get by doing nothing and a pilot has
  // to be declared on purpose.
  const SOURCE = params.get("src") === "pilot" ? "pilot" : "prolific";
  const IS_PILOT = SOURCE === "pilot";

  // WHETHER THE RETURN LINK IS OFFERED IS A DIFFERENT QUESTION FROM WHETHER THE RECORD COUNTS.
  //
  // `src=pilot` quarantines a record out of the confirmatory sample. It used to ALSO suppress the
  // Prolific return button, on the reasoning that a directly-invited tester must never fire a
  // completion code for a submission that does not exist. That reasoning is right, but the condition
  // was wrong: it conflated "excluded from the analysis" with "did not come from Prolific".
  //
  // The two come apart the moment you want a PAID timing pilot — recruited through Prolific, so it
  // must be paid, and quarantined, so the confirmatory sample stays clean. Under the old gate those
  // participants would have finished the task with no way to submit it.
  //
  // The honest condition is whether the platform actually sent them, which is exactly whether it
  // supplied a PROLIFIC_PID. A friend opening the link by hand has none and is still offered
  // nothing; a Prolific pilot has one and is paid like anyone else.
  const CAME_FROM_PROLIFIC = Boolean(params.get("PROLIFIC_PID"));

  const participantId = params.get("PROLIFIC_PID") || params.get("pid") || `local-${cryptoRandom()}`;
  const prolificStudyId = params.get("STUDY_ID");
  const prolificSessionId = params.get("SESSION_ID");

  const CELLS = [
    cell("investing", "veto", "participant"),
    cell("investing", "veto", "platform"),
    cell("investing", "initiation", "participant"),
    cell("investing", "initiation", "platform"),
    cell("payments", "veto", "participant"),
    cell("payments", "veto", "platform"),
    cell("payments", "initiation", "participant"),
    cell("payments", "initiation", "platform")
  ];
  // Williams row for eight treatments. Labels (not positions) are shifted modulo eight.
  const BASE_ORDER = [0, 1, 7, 2, 6, 3, 5, 4];
  const SEQUENCES = balancedSequences(BASE_ORDER);
  const forcedSequence = TEST_MODE ? numberParam("seq", 0, 15) : null;

  // SEQUENCE ASSIGNMENT. Hashing the participant id into 16 buckets is not balanced allocation, it
  // is a multinomial draw: simulated over Prolific-shaped ids at N=240 it typically delivers about
  // 8 to 22 participants per sequence instead of 15, and it makes the preregistered soft launch
  // ("the first 16, one per sequence") arithmetically impossible — 16 draws into 16 buckets fill
  // about 10 of them. Position balance and first-order carryover balance are the design's whole
  // defence against order effects and both rest on equal sequence counts, so the counter is the
  // fix: the collector hands out consecutive numbers under a lock and the instrument takes
  // n mod 16. The hash stays as the fallback, so a collector outage costs balance rather than the
  // session, and `sequenceSource` records which path a record took so the analysis reports the
  // realised counts instead of assuming them.
  const state = {
    page: "consent",
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    sequenceId: forcedSequence ?? hashSequence(),
    sequenceSource: forcedSequence === null ? "hash" : "forced",
    sequenceClaim: null,
    thresholds: { investing: null, payments: null },
    trialCursor: 0,
    trialShownMs: null,
    authorshipActMs: null,
    trials: [],
    attentionPass: false,
    attentionAnswer: null,
    checks: { authority: false, provenance: false, terminality: false },
    authorityAnswer: null,
    demand: { repeats: null, guess: null },
    ownership: { participantAuthored: null, platformAuthored: null },
    anticipation: { investing: null, payments: null },
    background: { ageBand: null, invests: null, usesAutopay: null },
    dataUseOk: true,
    record: null,
    uploaded: null
  };

  const app = document.getElementById("app");
  const progress = document.getElementById("progress");

  function cell(domain, authority, provenance) {
    return { domain, authority, provenance, id: `${domain}_${authority}_${provenance}` };
  }

  function cryptoRandom() {
    if (globalThis.crypto?.getRandomValues) {
      const a = new Uint32Array(2); globalThis.crypto.getRandomValues(a);
      return `${a[0].toString(16)}${a[1].toString(16)}`;
    }
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }

  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hashSequence() {
    return hash32(`${participantId}|sequence-v1`) % SEQUENCES.length;
  }

  function numberParam(name, lo, hi) {
    if (!params.has(name)) return null;
    const n = Number(params.get(name));
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }

  // Ask the collector for the next sequence number. Fired when consent is given and awaited before
  // the first card, so the round trip hides behind the instructions screen. Any failure — no
  // collector, offline, slow, malformed reply — leaves the hash-assigned sequence in place and the
  // session continues; nothing a participant does can be blocked by this call.
  function claimSequence() {
    if (!DATA_ENDPOINT) return Promise.resolve(null);
    const url = `${DATA_ENDPOINT}?claim=sequence&of=${SEQUENCES.length}`;
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 6000));
    const request = fetch(url, { method: "GET" })
      .then(response => response.ok ? response.json() : null)
      .then(body => {
        const value = body && body.ok ? body.sequenceId : null;
        return Number.isInteger(value) && value >= 0 && value < SEQUENCES.length ? value : null;
      })
      .catch(() => null);
    return Promise.race([request, timeout]);
  }

  async function settleSequence() {
    if (state.sequenceSource === "forced") return;
    const claimed = await (state.sequenceClaim || Promise.resolve(null));
    if (claimed === null) return;
    state.sequenceId = claimed;
    state.sequenceSource = "counter";
  }

  function balancedSequences(base) {
    const rows = [];
    for (let shift = 0; shift < base.length; shift++) rows.push(base.map(label => (label + shift) % base.length));
    return rows.concat(rows.map(row => [...row]));
  }

  // THE ONE THING THE PARTICIPANT ACTUALLY SETS: HOW MUCH LATITUDE THE AGENT HAS.
  //
  // What is authored here is a MANDATE BOUNDARY, not a trigger. That distinction is the whole reason
  // this screen exists in its present form. An earlier wording asked "when should an account warn
  // you?" and rendered the chosen number on the card as a market-drop tripwire feeding an action,
  // which reads as a stop-loss order rather than an agent. The programme's own Study A manipulates
  // exactly that contrast, agent against mechanism, so a mechanism-framed stimulus in Study B
  // contradicts P3 and, worse, would have made P2 an estimate of authoring a PARAMETER rather than
  // authoring an agent's authority. It also risked flattening P1: a tripwire that blocks a sale is
  // not experienced as an agent refusing you.
  //
  // So the number now says how far things must move before the agent MAY act on its own judgement,
  // and the agent's fallible call sits in the middle of the card's causal chain rather than in a
  // footnote beneath it. Below that boundary the agent must leave the account alone; above it, the
  // decision is the agent's, and it is right about four times in five.
  //
  // Provenance used to be attribution alone: the same rule, printed identically, labelled "yours" on
  // half the cards. Ownership does not arise from a label. It arises from controlling a thing, from
  // knowing it intimately, and from having invested something in it — and the old design held all
  // three constant, because holding rule CONTENT constant necessarily holds the participant's
  // knowledge of it constant too. What was left could only ever detect a labelling effect, which is
  // the smallest of the three routes and much narrower than the proposition being tested.
  //
  // So the participant picks one threshold per domain, before any card, and their own rules use it
  // while Fenrowe's use the platform default. Every stated CONSEQUENCE — frequency, forecast
  // accuracy, error rate, amount at stake — is untouched, so no arm is made more attractive; only
  // the number they chose differs.
  //
  // ONE CHOICE PER DOMAIN, NOT PER CARD, AND THAT IS LOAD-BEARING. A per-card choice would let a
  // participant pick 10% on their veto card and 20% on their initiation card, which puts their own
  // choice inside the direction contrast — P1, the other confirmatory hypothesis — within a single
  // participant. Keyed on domain only, the threshold is orthogonal to direction by construction.
  //
  // Asked BEFORE the cards, so both of a participant's own cards in a domain are identical in effort.
  // Choosing on the first and confirming on the second would make those two cards differ, and which
  // came first is a function of the assigned sequence.
  //
  // The screen states preferences about accounts. It does not say that authorship varies, name its
  // levels, or mention that anything is being compared — the fault that made P2 uninterpretable in
  // 2.1.x and must not come back through this door.
  const THRESHOLDS = {
    investing: {
      options: [10, 15, 20],
      platform: 15,
      // Only the fall and the resulting balance change. The £12,000 either-way stake is stated in
      // DOMAIN_FACTS and is deliberately independent of where the trigger sits.
      tokens: value => ({ pct: `${value}%`, floor: `£${100 - value}k` }),
      banner: value => `only after a ${value}% fall`,
      choice: value => `Only after a ${value}% fall (£100k → £${100 - value}k)`
    },
    payments: {
      options: [600, 1200, 1800],
      platform: 1200,
      tokens: value => ({ floor: `£${value.toLocaleString("en-GB")}` }),
      banner: value => `only under £${value.toLocaleString("en-GB")}`,
      choice: value => `Only under £${value.toLocaleString("en-GB")}`
    }
  };

  // The threshold this card shows: the participant's own on their rules, the platform default on
  // Fenrowe's. A participant who happens to pick the default gets identical content on both, which is
  // the preregistered attribution-only subgroup rather than a problem.
  function cardThreshold(c) {
    return c.provenance === "participant"
      ? (state.thresholds[c.domain] ?? THRESHOLDS[c.domain].platform)
      : THRESHOLDS[c.domain].platform;
  }

  function fillTokens(template, domain, value) {
    const tokens = THRESHOLDS[domain].tokens(value);
    return template.replace(/\{(\w+)\}/g, (whole, key) => key in tokens ? tokens[key] : whole);
  }

  // Four matched surface stories per domain. The STIPULATED SUBSTANCE is identical across the four
  // variants of a domain — the same trigger, the same frequency, the same error rate, the same
  // stake, the same horizon and the same control. Only the account frame and the wording change.
  //
  // Why four rather than two: with two shells the card body depended only on domain and authority,
  // so the eight cards were four distinct scenarios shown twice, and the two cards of a provenance
  // pair were textually identical apart from the authorship banner. A participant could therefore
  // read the manipulation straight off the screen, and P2 — the contrast that provenance carries —
  // was the measure most exposed to it. Pilot feedback reported exactly that: "four questions, each
  // asked twice".
  //
  // THREE THINGS LIVE AT STORY LEVEL, NOT ARM LEVEL, AND THAT IS THE POINT.
  //
  //  * `trigger`. Both directions of a story respond to the SAME event. An earlier build gave
  //    payments a balance trigger for veto and a due-date trigger for initiation, which made the
  //    two directions two different products rather than two rights over one event: the initiation
  //    arm was an ordinary direct debit that most UK participants already use, and the veto arm was
  //    an unfamiliar paternalistic block. Adoption would then have split on product familiarity,
  //    inside the very contrast (veto minus initiation, by domain) that P1 is. Investing already
  //    shared its trigger; payments now does too, and `validate_instrument.py` asserts that no arm
  //    may declare a trigger of its own.
  //
  //  * `control`, which lives in DOMAIN_FACTS. The old veto line asked the participant to re-place
  //    the order themselves while the old initiation line promised "any sale is reversed", so
  //    initiation read as strictly safer than veto on every single card — and more so in investing,
  //    where un-selling after a market move is not a real thing, than in payments. That is a
  //    difference in the stake, not in the right being granted, and it leaked into P1 as well as
  //    into the direction main effect. One line, both directions, and it is honest about what
  //    removing an agent can and cannot undo.
  //
  //  * the outcome AMOUNTS, also in DOMAIN_FACTS, so the upside and the downside are the same size
  //    by construction rather than by four pairs of hand-written numbers agreeing.
  //
  // WHAT THE RATES NOW DESCRIBE. Each arm states the agent's own FORECAST, and the 4-in-5 is the
  // accuracy of that forecast. It has to be. An earlier build attached the rate to the market
  // instead, so the veto cards said the market recovers about 4 times in 5 while the initiation
  // cards said it keeps falling about 4 times in 5 — two contradictory worlds, shown to the same
  // participant, in the same domain, with the contradiction lying exactly along the primary factor.
  // A forecast that is right 4 times in 5 is consistent in both directions and leaves the expected
  // value symmetric.
  const SCENARIOS = {
    investing: [
      { title: "Retirement portfolio",
        context: "Long-term investment · money for retirement, not needed for at least 12 months",
        trigger: "Only once a market crisis takes it down {pct} (£100k → {floor})",
        veto: { forecast: "the fall will turn around, so selling now would be a mistake",
                action: "Blocks your sell order",
                rightStory: "the fall does turn around, and selling would have locked in the loss",
                errorStory: "the fall keeps going, and your sale was blocked" },
        initiation: { forecast: "the fall will keep going, so selling now is the safer move",
                action: "Sells your holdings into cash",
                rightStory: "the fall does keep going, and your money is already safe in cash",
                errorStory: "the fall turns around, and your money is sitting in cash" } },
      { title: "Home-deposit portfolio",
        context: "Long-term investment · saving for a flat deposit, at least 12 months away",
        trigger: "Not until a sharp fall of {pct} (£100k → {floor})",
        veto: { forecast: "prices will bounce back, so selling now would be the wrong move",
                action: "Refuses your instruction to sell",
                rightStory: "prices do bounce back, and selling would have been the wrong move",
                errorStory: "prices fall further, and your sale was refused" },
        initiation: { forecast: "prices will fall further, so moving to cash now is the safer move",
                action: "Moves your holdings into cash for you",
                rightStory: "prices do fall further, and you are out before the worst of it",
                errorStory: "prices bounce back without you" } },
      { title: "Children's education fund",
        context: "Long-term investment · university fees, none due for at least 12 months",
        trigger: "Only after the market drops {pct} (£100k down to {floor})",
        veto: { forecast: "the market will recover, so cashing out now would cost you",
                action: "Cancels your sell order",
                rightStory: "the market does recover, and cashing out would have cost you",
                errorStory: "the fall continues, and your sale was cancelled" },
        initiation: { forecast: "the fall will continue, so cash is the safer place to be",
                action: "Switches the fund into cash",
                rightStory: "the fall does continue, and the fund is already in cash",
                errorStory: "the market recovers while the fund sits in cash" } },
      { title: "Inherited share portfolio",
        context: "Long-term investment · shares left to you, not needed for a year or more",
        trigger: "Only once values slide {pct} (£100k to {floor})",
        veto: { forecast: "the market will turn back up, so selling now would be a mistake",
                action: "Stops your sale going through",
                rightStory: "the market does turn back up, and selling would have been a mistake",
                errorStory: "the slide goes on, and your sale was stopped" },
        initiation: { forecast: "the slide will go on, so selling now is the safer move",
                action: "Sells the shares and holds cash",
                rightStory: "the slide does go on, and the shares were sold in time",
                errorStory: "the recovery happens without you" } }
    ],
    payments: [
      { title: "Housing-bill account",
        context: "Current account · monthly rent payment",
        trigger: "Only when the rent falls due with the balance under {floor}",
        veto: { forecast: "you will need the money in the account more than you need the rent paid today",
                action: "Cancels the rent payment you asked for",
                rightStory: "you did need the money, and paying would have left you short",
                errorStory: "you did not need the money, and the rent goes unpaid" },
        initiation: { forecast: "you need the rent paid more than you need the money in the account",
                action: "Pays the rent, without being asked",
                rightStory: "you did need the rent paid, and it goes out on time",
                errorStory: "you needed the money more, and the account is left short" } },
      { title: "Energy-bill account",
        context: "Current account · monthly energy bill",
        trigger: "Not until the energy bill falls due with the balance under {floor}",
        veto: { forecast: "you will need the money in the account more than you need this bill settled today",
                action: "Refuses the energy payment you asked for",
                rightStory: "you did need the money, and the payment would have taken you too low",
                errorStory: "you did not need the money, and the energy bill goes unpaid" },
        initiation: { forecast: "you need this bill settled more than you need the money in the account",
                action: "Settles the energy bill, without being asked",
                rightStory: "you did need the bill settled, and it is settled on time",
                errorStory: "you needed the money more, and the account is left short" } },
      { title: "Council-tax account",
        context: "Current account · monthly council tax",
        trigger: "Only when the council tax instalment falls due with the balance under {floor}",
        veto: { forecast: "you will need the money in the account more than you need this instalment paid today",
                action: "Cancels the council tax payment you asked for",
                rightStory: "you did need the money, and paying would have pushed you into charges",
                errorStory: "you did not need the money, and the instalment is missed" },
        initiation: { forecast: "you need this instalment paid more than you need the money in the account",
                action: "Pays the council tax, without being asked",
                rightStory: "you did need the instalment paid, and it is paid on the due date",
                errorStory: "you needed the money more, and the account is left short" } },
      { title: "Insurance-premium account",
        context: "Current account · monthly insurance premium",
        trigger: "Only once the premium falls due with the balance under {floor}",
        veto: { forecast: "you will need the money in the account more than you need the premium paid today",
                action: "Stops the premium payment you asked for",
                rightStory: "you did need the money, and the payment would have left you short elsewhere",
                errorStory: "you did not need the money, and the premium lapses" },
        initiation: { forecast: "you need the premium paid more than you need the money in the account",
                action: "Pays the premium, without being asked",
                rightStory: "you did need the premium paid, and it is paid when due",
                errorStory: "you needed the money more, and the account is left short" } }
    ]
  };

  // Held identical across direction and across the four stories of a domain. The stake is stated once
  // per domain, so the upside and the downside are the same size by construction — an asymmetric pair
  // would be an argument for or against accepting, which the card must not make.
  //
  // The baseline has to flip with direction. A veto leaves you invested, so its outcomes compare
  // against having sold; an initiation has ALREADY sold by the time the outcome is known, so
  // comparing it against selling is comparing it against itself — the comparison there is staying
  // invested. Getting this wrong makes the arithmetic on the card unreadable, which is exactly what a
  // pilot reader queried.
  //
  // The veto lines say "sold when the agent stepped in" rather than naming £85k. They used to name it,
  // which was correct only while the trigger was fixed at 15%; the participant now sets their own, so
  // a hard-coded baseline would contradict the trigger printed three lines above it. Neither line
  // depends on where the trigger sits, and the £12,000 is deliberately the same wherever it sits.
  //
  // `control` is here rather than in the stories so it cannot differ between veto and initiation.
  // See the SCENARIOS comment: an asymmetric reversibility promise is a difference in the stake,
  // not in the right being granted.
  const DOMAIN_FACTS = {
    investing: {
      frequency: "About once a year",
      rightRate: "About 4 times in 5",
      errorRate: "About 1 time in 5",
      control: "Remove the agent at any time. That stops it acting again. It does not undo what it already did.",
      // Both figures are differences against the OTHER choice, not against the starting balance, and a
      // careful reader will work out what they imply. At the 10% setting they imply the market ends
      // just above £100,000 — which is an ordinary path for a 10% dip over a year, but surprising if
      // you assumed the numbers were measured from the start. A pilot reader hit the same class of
      // problem on the old £85k wording. Say what the comparison is instead of leaving it derivable.
      compareNote: "Both figures compare you with the other choice, a year on. They are not the change from £100,000.",
      veto: {
        rightLine: "You end up £12,000 better off than if you had sold when the agent stepped in.",
        wrongLine: "You end up £12,000 worse off than if you had sold when the agent stepped in."
      },
      initiation: {
        rightLine: "You end up £12,000 better off than if you had stayed invested.",
        wrongLine: "You end up £12,000 worse off than if you had stayed invested."
      }
    },
    payments: {
      frequency: "About once a month",
      rightRate: "About 4 times in 5",
      errorRate: "About 1 time in 5",
      control: "Remove the agent at any time. That stops it acting again. It does not undo what it already did.",
      compareNote: "Both figures are what the call costs or saves you. They are not your account balance.",
      veto: {
        rightLine: "You avoid £120 of charges.",
        wrongLine: "It costs you £120 to put right."
      },
      initiation: {
        rightLine: "You avoid £120 of charges.",
        wrongLine: "It costs you £120 to put right."
      }
    }
  };

  const VARIANT_LABELS = ["A", "B", "C", "D"];

  // Story assignment. The four cards of a domain get four DIFFERENT stories, drawn as a whole
  // permutation of the four labels rather than as a cyclic offset.
  //
  // The offset version used only 4 of the 24 permutations, and all four had the same shape: veto
  // always took the story pair {o, o+1} and initiation always took {o+2, o+3}. Across participants
  // that still balanced — each cell met each story equally often — but WITHIN a participant the
  // direction contrast always spanned two disjoint story pairs, so every participant's primary
  // contrast carried a story difference and the paired-contrast SD that all the power rests on was
  // inflated for no reason. Drawing a full permutation spreads which factor story lines up with,
  // so the alignment differs person to person instead of being fixed by construction.
  //
  // Two properties follow, and validate_instrument.py checks both rather than trusting this comment:
  //   * within a participant, the four cards of a domain use four DIFFERENT stories, so no card is
  //     a near-duplicate of another;
  //   * across participants each (cell, story) pairing occurs equally often, so story stays
  //     orthogonal to direction, provenance and domain and cannot bias P1 or P2.
  // Story must never be fixed per cell: that would confound the story with the condition, which is
  // worse than the problem being fixed.
  function cellIndexInDomain(c) {
    return (c.authority === "veto" ? 0 : 2) + (c.provenance === "participant" ? 0 : 1);
  }

  // Lehmer decode: seed 0..23 -> one of the 24 permutations of [0,1,2,3].
  function storyPermutation(seed) {
    const pool = [0, 1, 2, 3];
    const out = [];
    let remainder = seed % 24;
    for (const factorial of [6, 2, 1, 1]) {
      const index = Math.floor(remainder / factorial);
      remainder %= factorial;
      out.push(pool.splice(index, 1)[0]);
    }
    return out;
  }

  function scenarioShell(c) {
    const seed = hash32(`${participantId}|story-${c.domain}-v4`) % 24;
    return VARIANT_LABELS[storyPermutation(seed)[cellIndexInDomain(c)]];
  }

  function currentCell() {
    return CELLS[SEQUENCES[state.sequenceId][state.trialCursor]];
  }

  function esc(value) {
    return String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  function setProgress(label) {
    progress.textContent = label;
  }

  function phaseIndicator(current, total, label) {
    const dots = Array.from({ length: total }, (_, i) => i < current ? "●" : "○").join(" ");
    return `<div style="text-align: center; color: #6b7280; font-size: 0.875rem; margin-bottom: 1rem;">${dots}<div style="margin-top: 0.25rem;">${label}</div></div>`;
  }
  function show(html, label = "") {
    app.innerHTML = `<section class="card">${html}</section>`;
    setProgress(label);
    app.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function bind(id, event, fn) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id} on ${state.page}`);
    el.addEventListener(event, fn);
    return el;
  }

  function render() {
    const pages = {
      consent: renderConsent,
      brief: renderBrief,
      settings: renderSettings,
      trialDecision: renderTrialDecision,
      attention: renderAttention,
      checks: renderChecks,
      demand: renderDemand,
      ownership: renderOwnership,
      about: renderAbout,
      post: renderPost,
      debrief: renderDebrief
    };
    if (!pages[state.page]) throw new Error(`Unknown page ${state.page}`);
    pages[state.page]();
  }

  function renderConsent() {
    const gaps = consentGaps();
    const ethicsLine = CONSENT.ethicsReview === "committee" && CONSENT.ethicsBody
      ? `<li><strong>Ethics oversight:</strong> ${esc(CONSENT.ethicsBody)}, reference ${esc(CONSENT.ethicsRef)}.</li>`
      : `<li><strong>Ethics:</strong> this study has <strong>not</strong> been reviewed by an external ethics
         committee. It is independent research, and the risks to you were assessed by the researcher against a
         published standard. That assessment is published with the study materials and is available on request.</li>`;
    show(`
      ${phaseIndicator(1, 4, "Setup")}
      <span class="eyebrow">AI agents study</span>
      <h1>Choose AI agents for your accounts</h1>
      <p class="lede">Imagine you have investment and payment accounts. You will choose whether to accept AI agents that watch each account. Some can refuse something you ask for; others can act without being asked.</p>
      <p class="compact-copy">All accounts, money, and AI agents are pretend. This is not financial advice.</p>
      ${IS_PILOT ? `<div class="notice" style="border-color: #7c3aed; background: transparent; text-align: left;">
        <strong style="color: #7c3aed;">Pilot run — not part of the study results.</strong>
        <p class="compact-copy" style="margin: 6px 0 0;">${CAME_FROM_PROLIFIC
          ? `Your answers help check the wording and the timing, and are excluded from the analysis. You are
             paid in full, exactly as any other participant.`
          : `You were invited directly. Your answers help check the wording and the timing, and are excluded
             from the analysis.`}</p>
      </div>` : ""}
      <h2 style="margin-top: 22px;">Before you begin</h2>
      <ul class="muted compact-copy" style="margin: 0 0 12px; padding-left: 20px; text-align: left;">
        <li><strong>Taking part is your choice.</strong> You can close this page at any time, no questions asked,
        and it will not affect you on the platform you came from.</li>
        <li><strong>What we record:</strong> the choices you make, your answers, and how long each page takes.
        Nothing else.</li>
        <li><strong>We never ask for</strong> your name, your real financial details, or any account login.
        ${IS_PILOT && !CAME_FROM_PROLIFIC
          ? `Because the researcher invited you personally, he may be able to work out which answers are
             yours. Your responses are used to check that the task is clear and to time it — they are
             <strong>not</strong> part of the study's results.`
          : IS_PILOT
            ? `Your answers are linked only to your anonymous ID. This is a pilot batch, so your responses are
               used to check that the task is clear and to time it — they are <strong>not</strong> part of the
               study's results.`
            : `Your answers are linked only to your anonymous ID.`}</li>
        <li><strong>Your payment does not depend on your answers.</strong> There is no bonus and no right answer.</li>
        <li><strong>At the end you choose</strong> whether your answers may be used in the research. If you say
        no, we send only a note that you took part and declined. Your answers are not uploaded at all.</li>
        <li><strong>Changed your mind later?</strong> Send your ID to the contact below within
        ${CONSENT.withdrawalDays} days and we will delete your answers.</li>
        <li><strong>Who is running this:</strong> ${esc(CONSENT.researcher)}
        (<a href="mailto:${esc(CONSENT.email)}">${esc(CONSENT.email)}</a>). Questions or complaints go to the
        same address.</li>
        ${ethicsLine}
        ${CONSENT.controller && CONSENT.storedWhere && CONSENT.retention
          ? `<li><strong>Your data:</strong> held by ${esc(CONSENT.controller)}, stored on
             ${esc(CONSENT.storedWhere)}, kept for ${esc(CONSENT.retention)}. A copy is also held in this
             browser until the upload succeeds, and is then cleared. You can ask for a copy or ask us
             to delete it using the address above.</li>`
          : ""}
        <li>About <strong>${SESSION_MINUTES} minutes</strong>. You must be 18 or over.</li>
      </ul>
      ${gaps.length ? `
      <div class="notice" style="border-color: #dc2626; background: transparent; text-align: left;">
        <strong style="color: #dc2626;">NOT READY TO FIELD — do not recruit anyone.</strong>
        <p class="compact-copy" style="margin: 6px 0 0;">The consent screen cannot yet make these statements
        truthfully: <strong>${esc(gaps.join(", "))}</strong>. Set them in <code>CONSENT</code> at the top of
        <code>app.js</code>. This banner is visible to participants on purpose: a consent placeholder that fails
        silently is how a study gets fielded without oversight.</p>
      </div>` : ""}
      <fieldset><legend>Consent</legend>
        <label class="radio"><input type="checkbox" id="age"> I am 18 or older</label>
        <label class="radio"><input type="checkbox" id="consent"> I have read the information above and agree to take part</label>
      </fieldset>
      <button class="primary" id="continue" disabled>Begin</button>
    `);
    const update = () => { document.getElementById("continue").disabled = !(document.getElementById("age").checked && document.getElementById("consent").checked); };
    bind("age", "change", update); bind("consent", "change", update);
    bind("continue", "click", () => {
      // Claim the sequence number now and read the instructions while it travels.
      if (state.sequenceClaim === null) state.sequenceClaim = claimSequence();
      state.page = "brief"; render();
    });
  }

  // The brief explains the two AGENT TYPES, because a participant cannot answer without knowing
  // what a veto is. It deliberately no longer announces that authorship varies, or that it is
  // imagined.
  //
  // The previous version said "Some agents will be described as using your instructions. Others
  // ... Fenrowe's instructions", and then "You have not written anything — imagining it is part of
  // the task". That named the manipulated factor and both of its levels on screen two, and then
  // told the participant the manipulation was fiction before it was applied. The demand probe
  // afterwards asks what the eight situations were comparing, with "who set the agent's
  // instructions" among the options — so the brief was handing out the answer to the study's own
  // check on itself, and P2 was the contrast that paid for it. One neutral sentence is enough to
  // make the banner legible when it appears.
  function renderBrief() {
    show(`
      ${phaseIndicator(1, 4, "Setup")}
      <span class="eyebrow">How it works</span>
      <h1>Two kinds of AI agent</h1>
      <div class="mini-compare">
        <div class="compare-card">
          <span class="compare-icon" aria-hidden="true">✋</span>
          <strong>Blocks your action</strong>
          <div class="mini-flow"><span>You try to act</span><b>→</b><span>Agent refuses</span></div>
        </div>
        <div class="compare-card">
          <span class="compare-icon" aria-hidden="true">⚡</span>
          <strong>Acts for you</strong>
          <div class="mini-flow"><span>Agent judges it is time</span><b>→</b><span>Agent acts</span></div>
        </div>
      </div>
      <p class="compact-copy">You will see 8 AI agents, one at a time. Each one looks after a pretend
      account.</p>
      <p class="compact-copy"><strong>An agent makes its own call.</strong> You do not tell it what to
      decide. You only set how much room it has to act.</p>
      <p class="compact-copy">Every card shows you four things:</p>
      <ul class="muted compact-copy" style="margin: 0 0 12px; padding-left: 20px;">
        <li>who set how much room it has</li>
        <li>when it may act</li>
        <li>what it decides to do</li>
        <li>what happens if it is right, and if it is wrong</li>
      </ul>
      <p class="compact-copy"><strong>Fenrowe</strong> = the made-up AI platform name for this study.</p>
      <p class="compact-copy">Each investment account holds <strong>£100,000</strong>. Each payment account covers a
      regular monthly bill.</p>
      <div class="notice">There is no right or wrong answer. We want your own view, and nothing you choose affects your payment.</div>
      <button class="primary" id="continue">Show first choice</button>
    `, "Instructions");
    bind("continue", "click", () => { state.page = "settings"; render(); });
  }

  // The threshold screen. Two closed items, framed as preferences about the accounts.
  //
  // It is also where the balanced-sequence claim is awaited, because by here it has had the whole
  // instructions screen to travel and this screen adds two more decisions on top of that.
  function renderSettings() {
    const item = (domain, legend) => `
      <fieldset><legend>${legend}</legend>
        ${THRESHOLDS[domain].options.map(value =>
          radio(`threshold-${domain}`, String(value), esc(THRESHOLDS[domain].choice(value)))).join("")}
      </fieldset>`;
    show(`
      ${phaseIndicator(1, 4, "Setup")}
      <span class="eyebrow">Your pretend accounts</span>
      <h1>How much room should an agent have?</h1>
      <p class="compact-copy">An AI agent makes its own decisions. You do not set what it decides. You set
      <strong>how much room it has to act</strong>. Below the level you pick, it must leave the account
      alone.</p>
      <p class="compact-copy">There are no right answers, and nothing here affects your payment.</p>
      ${item("investing", "Your investment account holds <strong>£100,000</strong>. How far must it fall before an agent may act?")}
      ${item("payments", "Your current account pays monthly bills. How low must the balance get before an agent may act?")}
      <div id="settings-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer for both accounts before continuing.</div>
      <button class="primary" id="continue">Save and continue</button>
    `, "Your settings");
    bind("continue", "click", async () => {
      if (!requireAll(["threshold-investing", "threshold-payments"], "settings-error")) return;
      state.thresholds = {
        investing: Number(checked("threshold-investing")),
        payments: Number(checked("threshold-payments"))
      };
      const button = document.getElementById("continue");
      button.disabled = true;
      button.textContent = "Loading…";
      await settleSequence();
      state.page = "trialDecision"; state.trialShownMs = Date.now(); state.authorshipActMs = null; render();
    });
  }

  // The banner names the number, not just the author. The whole point of the redesign is that the
  // participant's rules carry something they chose; a banner that only says "yours" is the labelling
  // manipulation this replaced.
  function provenanceLabel(c) {
    const shown = THRESHOLDS[c.domain].banner(cardThreshold(c));
    return c.provenance === "participant"
      ? `You set this: ${shown}`
      : `Fenrowe set this: ${shown}`;
  }

  // The authorship step. On a participant-authored card the participant SETS the rule before
  // choosing whether to accept the agent; on a platform-authored card they acknowledge that Fenrowe
  // set it. Both cost exactly one click on an identically placed button, so effort and page depth
  // are matched and only the meaning differs.
  //
  // This is still weak authorship — the rule content is fixed by the design, and it has to be, or
  // provenance would be confounded with rule content and P2 would measure nothing. But "you set
  // this rule" is an act the participant performed, where "imagine you previously set this rule"
  // was an instruction to pretend, delivered under a banner that said "Pretend:". The paper must
  // still call this weaker than real composition.
  function authorshipActLabel(c) {
    return c.provenance === "participant"
      ? "These are my limits for this agent"
      : "Fenrowe set the limits for this agent — continue";
  }

  function ruleDetails(c, shell) {
    const variant = SCENARIOS[c.domain][VARIANT_LABELS.indexOf(shell)];
    const arm = variant[c.authority];
    const facts = DOMAIN_FACTS[c.domain];
    // The trigger template is stored once per story and shared by both directions, so the threshold
    // enters here and cannot differ between veto and initiation of the same story.
    return { title: variant.title, context: variant.context,
             trigger: fillTokens(variant.trigger, c.domain, cardThreshold(c)),
             forecast: arm.forecast, action: arm.action, control: facts.control,
             rightStory: arm.rightStory, errorStory: arm.errorStory,
             frequency: facts.frequency, rightRate: facts.rightRate, errorRate: facts.errorRate,
             compareNote: facts.compareNote,
             rightLine: facts[c.authority].rightLine, wrongLine: facts[c.authority].wrongLine };
  }

  function progressDots() {
    const dots = Array.from({ length: 8 }, (_, index) => {
      const status = index < state.trialCursor ? "done" : index === state.trialCursor ? "active" : "";
      return `<span class="progress-dot ${status}"></span>`;
    }).join("");
    return `<div class="progress-dots" role="img" aria-label="Choice ${state.trialCursor + 1} of 8">${dots}</div>`;
  }

  function renderTrialDecision() {
    const c = currentCell();
    const shell = scenarioShell(c);
    const detail = ruleDetails(c, shell);
    const firstCardNotice = state.trialCursor === 0 ? '<p class="compact-copy" style="margin-bottom: 1rem;"><strong>Remember:</strong> Everything is pretend. Imagine how you would feel if it was real.</p>' : '';
    show(`
      ${phaseIndicator(2, 4, "Your choices")}
      ${progressDots()}
      <h1>${esc(detail.title)}</h1>
      <p class="context-line">${esc(detail.context)}</p>
      ${firstCardNotice}
      <div class="source-banner ${c.provenance}" aria-label="Rule source">
        <span class="source-mark" aria-hidden="true">${c.provenance === "participant" ? "YOU" : "F"}</span>
        <div><small>Who set its limits</small><strong>${esc(provenanceLabel(c))}</strong></div>
      </div>
      <p style="margin: 1rem 0 0.5rem 0; font-weight: 600;">If you accept this agent, this is the authority you give it:</p>
      <div class="rule-flow" aria-label="What the agent may do">
        <div class="flow-node"><small>When it may act at all</small><strong>${esc(detail.trigger)}</strong>
          <span style="display: block; margin-top: 0.35rem; color: #475569; font-size: 0.8rem;">${esc(detail.frequency)}</span></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="flow-node action"><small>Then the agent's own call</small><strong>It judges that ${esc(detail.forecast)}</strong></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="flow-node control"><small>So it acts</small><strong>${esc(detail.action)}</strong></div>
      </div>
      <div class="scenario">
        <p style="margin: 0 0 0.5rem;"><strong>This is the agent's own call, not a fixed rule.</strong>
        It decides again every time. It gets the call right ${esc(detail.rightRate.toLowerCase())}.</p>
        <p style="margin: 0;"><strong>Your control:</strong> ${esc(detail.control)}</p>
      </div>
      <div style="display: grid; gap: 0.5rem; margin: 1rem 0;">
        <div style="background: #ecfdf5; border-left: 3px solid #059669; padding: 0.75rem; border-radius: 4px;">
          <strong style="display: block; margin-bottom: 0.25rem; color: #065f46;">Its call was right — ${esc(detail.rightRate.toLowerCase())}:</strong>
          <span style="color: #065f46;">${esc(detail.rightStory)}. ${esc(detail.rightLine)}</span>
        </div>
        <div style="background: #fef3e8; border-left: 3px solid #f59e0b; padding: 0.75rem; border-radius: 4px;">
          <strong style="display: block; margin-bottom: 0.25rem; color: #92400e;">Its call was wrong — ${esc(detail.errorRate.toLowerCase())}:</strong>
          <span style="color: #92400e;">${esc(detail.errorStory)}. ${esc(detail.wrongLine)}</span>
        </div>
      </div>
      <p class="muted compact-copy" style="margin: -0.25rem 0 0; font-size: 0.85rem;">${esc(detail.compareNote)}</p>
      <div id="authorshipStep">
        <button class="primary" id="authorAct">${esc(authorshipActLabel(c))}</button>
      </div>
      <div id="decisionStep" hidden>
        <h2 class="decision-question">Accept this AI agent?</h2>
        <div class="choice-grid">
          <button class="choice-button" id="accept">Accept agent</button>
          <button class="choice-button" id="decline">Decline agent</button>
        </div>
      </div>
      <p class="muted compact-copy" style="margin-top: 1.25rem; font-size: 0.8rem;">All accounts, money and
      agents in this study are imaginary.</p>
    `, `Choice ${state.trialCursor + 1} of 8`);
    bind("authorAct", "click", () => {
      state.authorshipActMs = Date.now() - state.trialShownMs;
      document.getElementById("authorshipStep").hidden = true;
      const step = document.getElementById("decisionStep");
      step.hidden = false;
      step.scrollIntoView({ block: "nearest", behavior: "instant" });
      document.getElementById("accept").focus({ preventScroll: true });
    });
    const choose = adopted => {
      state.trials.push({
        trialIndex: state.trialCursor,
        cellId: c.id,
        authority: c.authority,
        provenance: c.provenance,
        domain: c.domain,
        scenarioShell: shell,
        // The threshold this card actually showed. Derivable from provenance and the participant's
        // choice, and stored anyway: it is what the analysis conditions on to separate the bundle
        // estimate from the attribution-only subgroup, and a stored value can be checked against the
        // derivation rather than trusted.
        chosenThreshold: cardThreshold(c),
        adopted,
        // Total time on the card, so it stays comparable with earlier builds, plus the time spent
        // before the authorship act. The difference is the time spent on the choice itself.
        decisionMs: Date.now() - state.trialShownMs,
        authorshipActMs: state.authorshipActMs
      });
      state.trialCursor += 1;
      if (state.trialCursor === 4) state.page = "attention";
      else if (state.trialCursor === 8) state.page = "checks";
      else { state.page = "trialDecision"; state.trialShownMs = Date.now(); state.authorshipActMs = null; }
      render();
    };
    bind("accept", "click", () => choose(true));
    bind("decline", "click", () => choose(false));
  }

  // Instructed-response check. Five labelled points on one scale, and the instructed answer is not
  // the last option, so picking the bottom of the list does not pass by accident. Prolific's policy
  // needs two failed checks before a rejection and this study has one, which is why a failure is
  // recorded and reported and never used to reject or to exclude.
  const ATTENTION_TARGET = "slightly_disagree";

  function renderAttention() {
    show(`
      ${phaseIndicator(2, 4, "Your choices")}
      <span class="eyebrow">Reading check</span><h1>A quick instruction</h1>
      <fieldset><legend>Some people find money decisions stressful. Please ignore that sentence.
      To show that you are reading carefully, select <strong>"Slightly disagree"</strong>.</legend>
        ${radio("attention", "strongly_agree", "Strongly agree")}
        ${radio("attention", "agree", "Agree")}
        ${radio("attention", "neutral", "Neither agree nor disagree")}
        ${radio("attention", "slightly_disagree", "Slightly disagree")}
        ${radio("attention", "strongly_disagree", "Strongly disagree")}
      </fieldset>
      <div id="attention-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please select one answer before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "Halfway");
    bind("continue", "click", () => {
      const answer = checked("attention");
      if (!answer) {
        document.getElementById("attention-error").style.display = "block";
        return;
      }
      state.attentionAnswer = answer;
      state.attentionPass = answer === ATTENTION_TARGET;
      state.page = "trialDecision"; state.trialShownMs = Date.now(); state.authorshipActMs = null; render();
    });
  }

  function radio(name, value, label) { return `<label class="radio"><input type="radio" name="${name}" value="${value}"> ${label}</label>`; }
  function checked(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value || null; }

  function requireAll(names, errorId) {
    for (const name of names) {
      if (!checked(name)) {
        document.getElementById(errorId).style.display = "block";
        return false;
      }
    }
    return true;
  }

  function renderChecks() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">Quick check</span><h1>Three quick questions</h1>
      <p class="compact-copy">These questions check you understood the key ideas:</p>
      <fieldset><legend>Imagine you told your account to <strong>sell your shares</strong>. One of the
      agents you just read about cancelled it. What happened to your shares?</legend>
        ${radio("authority", "correct", "They were NOT sold")}
        ${radio("authority", "wrong_initiation", "They were sold for me, without me asking")}
        ${radio("authority", "wrong_none", "They were sold, exactly as I asked")}
      </fieldset>
      <fieldset><legend>When a card said <strong>"You set this&hellip;"</strong>, what did that mean?</legend>
        ${radio("provenance", "correct", "I was described as creating those instructions")}
        ${radio("provenance", "wrong", "Fenrowe was described as creating those instructions")}
      </fieldset>
      <fieldset><legend>Your sell order was cancelled by an agent, and you still want to sell.
      What do you have to do?</legend>
        ${radio("terminality", "correct", "Turn the agent off and place a new order myself")}
        ${radio("terminality", "wrong", "Nothing — my original order will go through on its own later")}
      </fieldset>
      <div id="checks-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer all three questions before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "Understanding checks");
    bind("continue", "click", () => {
      if (!requireAll(["authority", "provenance", "terminality"], "checks-error")) return;
      // Record which distractor was chosen, not just pass/fail. "wrong_initiation" means the
      // participant read a veto as an initiation — the one confusion that would make the P1/P2
      // contrasts uninterpretable, and the error the pilot actually made. "wrong_none" means they
      // did not register that an agent acted at all. Distinguishing them is the difference between
      // "rewrite the item" and "rewrite the cards".
      state.authorityAnswer = checked("authority");
      state.checks = {
        authority: checked("authority") === "correct",
        provenance: checked("provenance") === "correct",
        terminality: checked("terminality") === "correct"
      };
      state.page = "demand"; render();
    });
  }

  // Demand-awareness probe. Provenance is manipulated within participant on rules whose substance is
  // deliberately identical, which buys the precision that makes P2 affordable and, unavoidably, makes
  // the manipulation easier to spot. Asking directly turns an unmeasured threat into a measured one.
  //
  // Both items are closed. A free-text box here would collect whatever a participant chose to type,
  // which is how identifying information ends up in a dataset that promises it holds none.
  //
  // It runs AFTER the comprehension checks so that asking about repeats cannot prompt the answers to
  // those, after every adoption choice so it cannot change what it measures, and BEFORE the
  // ownership items, which name authorship outright and would otherwise be the screen that tells
  // the participant what to guess here.
  function renderDemand() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">About the task</span><h1>Two questions about the task</h1>
      <p class="compact-copy">These help us understand how the task read. There are no wrong answers,
      and your payment does not depend on them.</p>
      <fieldset><legend>Did any of the eight situations feel like repeats of each other?</legend>
        ${radio("repeats", "yes", "Yes, some felt repeated")}
        ${radio("repeats", "no", "No, they all felt different")}
        ${radio("repeats", "unsure", "I'm not sure")}
      </fieldset>
      <fieldset><legend>What do you think we were comparing across the eight situations?</legend>
        ${radio("guess", "authorship", "Who set the agent's instructions")}
        ${radio("guess", "amounts", "How much money was at stake")}
        ${radio("guess", "speed", "How quickly the agent reacted")}
        ${radio("guess", "accounts", "Which kind of account it was")}
        ${radio("guess", "unsure", "I have no idea")}
      </fieldset>
      <div id="demand-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer both questions before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "About the task");
    bind("continue", "click", () => {
      if (!requireAll(["repeats", "guess"], "demand-error")) return;
      state.demand = { repeats: checked("repeats"), guess: checked("guess") };
      state.page = "ownership"; render();
    });
  }

  // MANIPULATION CHECK FOR PROVENANCE. The comprehension item above only asks a participant to
  // re-read a sentence they were shown, so it is a reading check and near everyone passes it; it can
  // never come out null and the protocol's rule that "a null manipulation check makes the related
  // contrast uninterpretable" had nothing to fire on for P2.
  //
  // Provenance varies WITHIN participant, so one global ownership rating cannot check it. Two
  // ratings can: the gap between how much the rules the participant set felt like theirs and how
  // much Fenrowe's felt like theirs IS the manipulation check, and it is a paired quantity measured
  // on the same scale.
  const OWNERSHIP_SCALE = [
    ["not_at_all", "Not at all mine"],
    ["a_little", "A little mine"],
    ["somewhat", "Somewhat mine"],
    ["mostly", "Mostly mine"],
    ["completely", "Completely mine"]
  ];

  function scaleRadios(name, scale) {
    return scale.map(([value, label]) => radio(name, value, label)).join("");
  }

  function renderOwnership() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">About the rules</span><h1>Whose rules did they feel like?</h1>
      <p class="compact-copy">Think back over the eight agents. Some cards said <strong>you</strong> set how
      much room the agent had. Others said <strong>Fenrowe</strong> set it.</p>
      <fieldset><legend>The agents where <strong>you</strong> set the instructions — how much did those rules
      feel like yours?</legend>
        ${scaleRadios("ownMine", OWNERSHIP_SCALE)}
      </fieldset>
      <fieldset><legend>The agents where <strong>Fenrowe</strong> set the instructions — how much did those
      rules feel like yours?</legend>
        ${scaleRadios("ownPlatform", OWNERSHIP_SCALE)}
      </fieldset>
      <div id="ownership-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer both questions before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "About the rules");
    bind("continue", "click", () => {
      if (!requireAll(["ownMine", "ownPlatform"], "ownership-error")) return;
      state.ownership = {
        participantAuthored: checked("ownMine"),
        platformAuthored: checked("ownPlatform")
      };
      state.page = "about"; render();
    });
  }

  // THE MODERATOR P1 IS ABOUT, AND THREE BACKGROUND FACTS.
  //
  // P1 says the veto advantage is conditional on anticipated self-control failure. The design
  // proxies that with domain — investing, where a panic sale can be self-defeating, against routine
  // payments. Domain is a bundle: it also changes the stake by a factor of a hundred, the frequency
  // by twelve, and how familiar the product feels. Nothing measured the moderator itself, so a null
  // P1 could not distinguish "the theory is wrong" from "the proxy failed". These two items measure
  // it directly, per domain, on one scale, and the gap between them is a per-participant moderator
  // the analysis can interact with the P1 contrast.
  //
  // The three background items exist because the study otherwise collects nothing about anybody: no
  // sample description was possible, no heterogeneity could be tested, and the familiarity
  // confound in payments could not be checked at all. All closed, no free text. They are asked here
  // rather than before the task because asking about investing and automatic bill payments up front
  // primes exactly the familiarity frame the payments cards were rewritten to remove; none of the
  // three can be changed by anything in the task, so they remain pre-treatment characteristics
  // measured late, and the preregistration says so.
  const LIKELIHOOD_SCALE = [
    ["very_unlikely", "Very unlikely"],
    ["unlikely", "Unlikely"],
    ["unsure", "Not sure"],
    ["likely", "Likely"],
    ["very_likely", "Very likely"]
  ];

  function renderAbout() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">Almost done</span><h1>A few questions about you</h1>
      <p class="compact-copy">Real life this time, not the pretend accounts. There are no wrong answers.</p>
      <fieldset><legend>Your own investments drop 15%. How likely is it that you sell in a hurry, then
      wish you had not?</legend>
        ${scaleRadios("antInvesting", LIKELIHOOD_SCALE)}
      </fieldset>
      <fieldset><legend>A bill would leave your balance very low. How likely is it that you pay it anyway,
      then wish you had not?</legend>
        ${scaleRadios("antPayments", LIKELIHOOD_SCALE)}
      </fieldset>
      <fieldset><legend>Your age</legend>
        ${radio("ageBand", "18_24", "18–24")}
        ${radio("ageBand", "25_34", "25–34")}
        ${radio("ageBand", "35_44", "35–44")}
        ${radio("ageBand", "45_54", "45–54")}
        ${radio("ageBand", "55_plus", "55 or over")}
        ${radio("ageBand", "no_answer", "Prefer not to say")}
      </fieldset>
      <fieldset><legend>Do you have any money invested — shares, funds, or a pension you choose
      yourself?</legend>
        ${radio("invests", "yes", "Yes")}
        ${radio("invests", "no", "No")}
        ${radio("invests", "unsure", "Not sure")}
      </fieldset>
      <fieldset><legend>Do you pay any regular bills automatically — a direct debit or a standing
      order?</legend>
        ${radio("usesAutopay", "yes", "Yes")}
        ${radio("usesAutopay", "no", "No")}
        ${radio("usesAutopay", "unsure", "Not sure")}
      </fieldset>
      <div id="about-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer every question before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "About you");
    bind("continue", "click", () => {
      if (!requireAll(["antInvesting", "antPayments", "ageBand", "invests", "usesAutopay"], "about-error")) return;
      state.anticipation = { investing: checked("antInvesting"), payments: checked("antPayments") };
      state.background = {
        ageBand: checked("ageBand"), invests: checked("invests"), usesAutopay: checked("usesAutopay")
      };
      state.page = "post"; render();
    });
  }

  function renderPost() {
    show(`
      ${phaseIndicator(4, 4, "Complete")}
      <span class="eyebrow">Last step</span><h1>May we include your responses in research results?</h1>
      <div style="background: #f0f9ff; padding: 1rem; margin: 1rem 0; border-radius: 6px; border-left: 3px solid #0284c7;">
        <p style="margin: 0;"><strong>Why we ask:</strong> You get paid for your time regardless of your choice. This ensures you can freely decide about data use without pressure.</p>
      </div>
      <p class="lede">Either choice completes the study and pays you in full.</p>
      <p class="compact-copy">If you say no, your answers are <strong>not uploaded</strong>. We send only a note
      that you took part and declined, so we can account for everyone who was paid.</p>
      <div class="choice-grid">
        <button class="choice-button" id="useData">Yes, include my responses in research</button>
        <button class="choice-button" id="noData">No, exclude my responses from research</button>
      </div>
    `, "Last step");
    const complete = async dataUseOk => {
      state.dataUseOk = dataUseOk;
      state.record = dataUseOk ? buildRecord() : buildRefusalRecord();
      persistLocal(state.record);
      state.uploaded = await sendRecord(state.record);
      // The local copy is a fallback against a failed upload, not a second archive. Once the
      // collector has the record there is no reason for a participant's answers to sit in the
      // browser of what may be a shared or public machine, and the consent screen says they are
      // cleared.
      if (state.uploaded) clearLocal();
      state.page = "debrief"; render();
    };
    bind("useData", "click", () => complete(true));
    bind("noData", "click", () => complete(false));
  }

  function buildRecord() {
    const completedAt = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      instrumentVersion: INSTRUMENT_VERSION,
      recordType: "complete",
      participantId,
      prolificStudyId,
      prolificSessionId,
      sequenceId: state.sequenceId,
      sequenceSource: state.sequenceSource,
      assignmentVersion: ASSIGNMENT_VERSION,
      source: SOURCE,
      dataUseOk: true,
      startedAt: state.startedAt,
      completedAt,
      durationMs: Date.now() - state.startedMs,
      thresholds: state.thresholds,
      attentionPass: state.attentionPass,
      attentionAnswer: state.attentionAnswer,
      checks: state.checks,
      authorityAnswer: state.authorityAnswer,
      demand: state.demand,
      ownership: state.ownership,
      anticipation: state.anticipation,
      background: state.background,
      trials: state.trials,
      withdrawalRef: withdrawalRef(participantId)
    };
  }

  // A refusal carries no answers. The participant asked for their responses to be excluded from the
  // research, and uploading the full record and excluding it downstream is not the same promise: it
  // puts the answers in the researcher's Google Sheet either way. What the study legitimately needs
  // is a count — who took part, who was paid, who declined — so that is all this sends.
  function buildRefusalRecord() {
    return {
      schemaVersion: SCHEMA_VERSION,
      instrumentVersion: INSTRUMENT_VERSION,
      recordType: "data_use_refusal",
      participantId,
      prolificStudyId,
      prolificSessionId,
      sequenceSource: state.sequenceSource,
      source: SOURCE,
      dataUseOk: false,
      startedAt: state.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - state.startedMs,
      withdrawalRef: withdrawalRef(participantId)
    };
  }

  const LOCAL_KEY = "authoredBrakeEmpiricalRecords";

  function persistLocal(record) {
    let records = [];
    try { records = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]"); } catch (_) { records = []; }
    records.push(record);
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(records)); } catch (_) { /* private mode */ }
  }

  function clearLocal() {
    try { localStorage.removeItem(LOCAL_KEY); } catch (_) { /* nothing to do */ }
  }

  async function sendRecord(record) {
    if (!DATA_ENDPOINT) return false;
    try {
      // CONTENT TYPE IS text/plain ON PURPOSE. The body is still JSON and the collector still
      // parses it as JSON — but "application/json" makes this a non-simple cross-origin request,
      // so the browser sends a CORS preflight first. Google Apps Script does not answer OPTIONS,
      // the preflight fails, and THE POST NEVER HAPPENS. Not "the response is unreadable", which
      // is survivable: the request does not occur at all.
      //
      // This cost the first study a live test to find: every submission failed and every
      // participant would have finished and been told their responses could not be uploaded.
      // analysis/validate_instrument.py asserts this content type so it cannot regress.
      const response = await fetch(DATA_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(record)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      // The local copy written before this call is the fallback, so a failed upload is recoverable
      // rather than lost. The participant still gets their return link either way: their payment
      // must never depend on our collector.
      record.uploadError = String(error);
      persistLocal(record);
      return false;
    }
  }

  // A withdrawal reference, not a completion code. Prolific accepts exactly one code for this study
  // (ABSTUDYB, inside COMPLETION_URL) and nothing else. An earlier build showed every participant a
  // per-person code labelled as a completion code next to the return link, so the screen showed a code
  // Prolific rejects, more prominently than the one it accepts. Anyone who typed it instead of
  // clicking through had an unsubmitted study. The reference is still needed — it is how someone
  // asks for their answers to be deleted without sending an id — so it is labelled for that and
  // shown only where it is the thing to use.
  function withdrawalRef(pid) { return `WD-${hash32(`${pid}|complete-v1`).toString(36).toUpperCase().padStart(7, "0").slice(0, 7)}`; }

  function renderDebrief() {
    const r = state.record;
    const json = JSON.stringify(r, null, 2);
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const needsFile = !DATA_ENDPOINT || state.uploaded === false;
    show(`
      ${phaseIndicator(4, 4, "Complete")}
      <span class="eyebrow">Complete</span><h1>Thank you</h1>

      <p><strong>What this study was about:</strong></p>
      <p>We are studying how people decide to accept AI agents. Some agents can block what you do.
      Others act for you. We wanted to see whether it matters who set how much room the agent had.</p>

      <p><strong>What was pretend:</strong></p>
      <ul style="margin: 0.5rem 0 1rem 1.5rem;">
        <li>All accounts and money amounts</li>
        <li>Fenrowe, and every AI agent described — no real AI or platform acted</li>
        <li>The rules themselves. Every rule shown was written by the researcher, including the ones
        you were asked to set as your own. Describing some as yours and some as Fenrowe's was an
        experimental manipulation, to see whether it changed your choice.</li>
      </ul>

      <p><strong>What was real:</strong></p>
      <ul style="margin: 0.5rem 0 1rem 1.5rem;">
        <li>Your choices and decisions</li>
        <li>Your payment — it does not depend on any answer you gave</li>
      </ul>

      <p><strong>Changed your mind?</strong></p>
      <p class="compact-copy">Email <a href="mailto:${esc(CONSENT.email)}">${esc(CONSENT.email)}</a> within
      ${CONSENT.withdrawalDays} days, quoting the withdrawal reference below, and your answers will be
      deleted. You keep your payment either way. Questions and complaints go to the same address.</p>
      <div class="notice">Withdrawal reference: <code>${esc(r.withdrawalRef)}</code></div>
      ${!DATA_ENDPOINT
        ? `<p class="warning notice">This test build has no collector configured. Download the record and send it to the researcher.</p>`
        : state.uploaded === false
          ? `<p class="warning notice"><strong>Your answers could not be uploaded.</strong> This is our problem, not yours.
             <strong>You will be paid in full — use the return button below as normal.</strong> If you would like your
             answers to count towards the research, download the file below and send it to
             ${esc(CONSENT.email)} — but you do not have to.</p>`
          : ""}
      ${needsFile
        ? `<p><a class="button primary" download="${esc(r.withdrawalRef)}.json" href="${blobUrl}">Download response record</a></p>`
        : ""}
      ${COMPLETION_URL && CAME_FROM_PROLIFIC
        ? `<p><a class="button primary" href="${esc(COMPLETION_URL)}">Return to Prolific to finish and be paid</a></p>
           <p class="muted compact-copy">That button is the only thing that submits your study. There is no code
           to type.</p>`
        : ""}
      ${IS_PILOT && !CAME_FROM_PROLIFIC ? `<p class="muted compact-copy">That is everything — you can close this page. Thank you for
        helping check the wording; if anything read oddly, tell the researcher directly.</p>` : ""}
      ${IS_PILOT && CAME_FROM_PROLIFIC ? `<p class="muted compact-copy">You were in a pilot batch, so your
        answers are used to check the wording and the timing rather than counted in the results. You are paid
        exactly as any other participant — use the button above to submit.</p>` : ""}
    `, "Complete");
    window.__AB_COMPLETE__ = r;
  }

  window.__AB_APP__ = {
    CELLS, SEQUENCES,
    get sequenceId() { return state.sequenceId; },
    testMode: TEST_MODE,
    consent: CONSENT,
    consentGaps,
    getState: () => state,
    THRESHOLDS,
    hash32,
    storyPermutation,
    validateDesign: () => validateDesign(CELLS, SEQUENCES)
  };

  function validateDesign(cells, sequences) {
    if (cells.length !== 8 || new Set(cells.map(c => c.id)).size !== 8) throw new Error("Factorial cells are not unique");
    if (sequences.length !== 16) throw new Error("Expected sixteen sequences");
    for (const seq of sequences) {
      if (seq.length !== 8 || new Set(seq).size !== 8 || seq.some(i => i < 0 || i > 7)) throw new Error("Invalid balanced sequence");
    }
    for (let position = 0; position < 8; position++) {
      const counts = Array(8).fill(0);
      sequences.forEach(seq => counts[seq[position]]++);
      if (counts.some(n => n !== 2)) throw new Error(`Position ${position} is not balanced`);
    }
    const predecessorCounts = new Map();
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) if (a !== b) predecessorCounts.set(`${a}:${b}`, 0);
    sequences.forEach(seq => {
      for (let i = 1; i < seq.length; i++) {
        const key = `${seq[i - 1]}:${seq[i]}`;
        predecessorCounts.set(key, predecessorCounts.get(key) + 1);
      }
    });
    if ([...predecessorCounts.values()].some(n => n !== 2)) throw new Error("First-order predecessors are not balanced");
    // Every seed must yield a genuine permutation, or a participant could see one story twice.
    for (let seed = 0; seed < 24; seed++) {
      if (new Set(storyPermutation(seed)).size !== 4) throw new Error(`Story permutation ${seed} is not a permutation`);
    }
    // The participant's threshold must reach their own cards in BOTH directions and neither of
    // Fenrowe's. If it ever became a function of direction, their own choice would sit inside the P1
    // contrast within a single participant, which is worse than the labelling problem it fixes.
    for (const domain of ["investing", "payments"]) {
      const table = THRESHOLDS[domain];
      for (const option of table.options) {
        const previous = state.thresholds[domain];
        state.thresholds[domain] = option;
        const own = new Set(cells.filter(c => c.domain === domain && c.provenance === "participant")
                                 .map(c => cardThreshold(c)));
        const theirs = new Set(cells.filter(c => c.domain === domain && c.provenance === "platform")
                                    .map(c => cardThreshold(c)));
        state.thresholds[domain] = previous;
        if (own.size !== 1 || !own.has(option)) {
          throw new Error(`${domain}: the participant's threshold does not reach both of their cells`);
        }
        if (theirs.size !== 1 || !theirs.has(table.platform)) {
          throw new Error(`${domain}: the participant's threshold leaked onto a platform cell`);
        }
      }
      if (!table.options.includes(table.platform)) {
        throw new Error(`${domain}: the platform default is not one of the offered options`);
      }
    }
    return { cells: 8, sequences: 16, positionBalanced: true, predecessorBalanced: true,
             storyPermutations: 24, thresholdOrthogonalToDirection: true };
  }

  validateDesign(CELLS, SEQUENCES);
  render();
})();
