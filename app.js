"use strict";

(() => {
  const SCHEMA_VERSION = "ab-empirical-2.1.0";
  const INSTRUMENT_VERSION = "study-b-2.1.0";
  const ASSIGNMENT_VERSION = "williams-variant-v3";
  const DATA_ENDPOINT = "https://script.google.com/macros/s/AKfycbwlL7Q1MTGulPDKc8r3UwYq_i-_7HEUxsOQhIDPSrxn4etn1_TtG2Gcq30NfwU5xtgPgw/exec";
  // Must match completion_codes[0].code in deploy/prolific/study-b.json. The code is chosen by
  // the researcher, not issued by Prolific, so these two files are the only source of truth.
  const COMPLETION_URL = "https://app.prolific.com/submissions/complete?cc=ABSTUDYB";
  // Test hooks (?seq=, ?selected=, selftest.js) are only honoured while no
  // production collector is configured, so participants cannot use them.
  const TEST_MODE = DATA_ENDPOINT === null;
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
  const sequenceId = forcedSequence ?? (hash32(`${participantId}|sequence-v1`) % SEQUENCES.length);

  const state = {
    page: "consent",
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    trialCursor: 0,
    trialStartMs: null,
    trials: [],
    attentionPass: false,
    checks: { authority: false, provenance: false, terminality: false },
    demand: { repeats: null, guess: null },
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

  function numberParam(name, lo, hi) {
    if (!params.has(name)) return null;
    const n = Number(params.get(name));
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }

  function balancedSequences(base) {
    const rows = [];
    for (let shift = 0; shift < base.length; shift++) rows.push(base.map(label => (label + shift) % base.length));
    return rows.concat(rows.map(row => [...row]));
  }

  // Four matched surface stories per domain. The STIPULATED SUBSTANCE is identical across the four
  // variants of a domain — the same 15% trigger and £12,000 error cost for investing, the same
  // £1,200 threshold and £120 error cost for payments, the same horizon and the same reversibility.
  // Only the account frame and the wording change.
  //
  // Why four rather than two: with two shells the card body depended only on domain and authority,
  // so the eight cards were four distinct scenarios shown twice, and the two cards of a provenance
  // pair were textually identical apart from the authorship banner. A participant could therefore
  // read the manipulation straight off the screen, and P2 — the contrast that provenance carries —
  // was the measure most exposed to it. Pilot feedback reported exactly that: "four questions, each
  // asked twice".
  const SCENARIOS = {
    investing: [
      { title: "Retirement portfolio",
        context: "Long-term investment · money for retirement, not needed for at least 12 months",
        veto: { trigger: "Agent watches for a market crisis (a 15% drop, £100k → £85k)",
                action: "Agent blocks your sell order",
                control: "You can remove the agent and place a new order at any time",
                errorStory: "You can't sell when you want → the market keeps falling → £12,000 lost" },
        initiation: { trigger: "Agent watches for a market crisis (a 15% drop, £100k → £85k)",
                action: "Agent sells your holdings into cash",
                control: "You can remove the agent at any time, and any sale is reversed",
                errorStory: "Agent sells too early → the market recovers → £12,000 of gains missed" } },
      { title: "Home-deposit portfolio",
        context: "Long-term investment · saving for a flat deposit, at least 12 months away",
        veto: { trigger: "Agent looks out for a sharp fall (15% down, £100k → £85k)",
                action: "Agent refuses your instruction to sell",
                control: "Remove the agent whenever you like, then sell yourself",
                errorStory: "Your sale is refused → prices fall further → you are £12,000 worse off" },
        initiation: { trigger: "Agent looks out for a sharp fall (15% down, £100k → £85k)",
                action: "Agent moves your holdings into cash for you",
                control: "Remove the agent whenever you like; the move is undone",
                errorStory: "Agent moves out too soon → prices bounce back → you miss £12,000" } },
      { title: "Children's education fund",
        context: "Long-term investment · university fees, none due for at least 12 months",
        veto: { trigger: "Agent monitors for a 15% market drop (£100k down to £85k)",
                action: "Agent cancels your sell order",
                control: "Switch the agent off at any point and sell as normal",
                errorStory: "The sale is cancelled → the fall continues → £12,000 gone" },
        initiation: { trigger: "Agent monitors for a 15% market drop (£100k down to £85k)",
                action: "Agent switches the fund into cash",
                control: "Switch the agent off at any point; the switch is reversed",
                errorStory: "The switch happens too early → markets recover → £12,000 forgone" } },
      { title: "Inherited share portfolio",
        context: "Long-term investment · shares left to you, not needed for a year or more",
        veto: { trigger: "Agent checks for a 15% slide in value (£100k to £85k)",
                action: "Agent stops your sale going through",
                control: "Take the agent off at any time and sell it yourself",
                errorStory: "Your sale is stopped → the slide goes on → £12,000 lost" },
        initiation: { trigger: "Agent checks for a 15% slide in value (£100k to £85k)",
                action: "Agent sells the shares and holds cash",
                control: "Take the agent off at any time; the sale is undone",
                errorStory: "Agent sells at the bottom → the recovery happens without you → £12,000 missed" } }
    ],
    payments: [
      { title: "Housing-bill account",
        context: "Current account · monthly rent payment",
        veto: { trigger: "Agent watches for a low balance (below £1,200)",
                action: "Agent blocks your rent payment",
                control: "You can remove the agent and pay manually at any time",
                errorStory: "The rent isn't paid → late fee and arrears charge = £120" },
        initiation: { trigger: "Agent watches for the rent due date",
                action: "Agent pays the rent automatically",
                control: "You can remove the agent at any time; any payment is reversed",
                errorStory: "Agent pays the wrong amount → £120 to put right" } },
      { title: "Energy-bill account",
        context: "Current account · monthly energy bill",
        veto: { trigger: "Agent looks out for the balance dropping under £1,200",
                action: "Agent refuses your energy payment",
                control: "Remove the agent whenever you like and pay it yourself",
                errorStory: "The bill goes unpaid → late fee and reconnection charge = £120" },
        initiation: { trigger: "Agent looks out for the bill's due date",
                action: "Agent settles the energy bill for you",
                control: "Remove the agent whenever you like; the payment is undone",
                errorStory: "Agent pays the wrong bill → £120 to reverse it" } },
      { title: "Council-tax account",
        context: "Current account · monthly council tax",
        veto: { trigger: "Agent monitors the balance for a dip below £1,200",
                action: "Agent cancels your council tax payment",
                control: "Switch the agent off at any point and pay as normal",
                errorStory: "The instalment is missed → penalty and recovery fee = £120" },
        initiation: { trigger: "Agent monitors the instalment date",
                action: "Agent pays the council tax on the due date",
                control: "Switch the agent off at any point; the payment is reversed",
                errorStory: "Agent pays twice → £120 to claim back" } },
      { title: "Insurance-premium account",
        context: "Current account · monthly insurance premium",
        veto: { trigger: "Agent checks whether the balance falls under £1,200",
                action: "Agent stops your premium going out",
                control: "Take the agent off at any time and pay it directly",
                errorStory: "The premium lapses → reinstatement fee = £120" },
        initiation: { trigger: "Agent checks the premium collection date",
                action: "Agent pays the premium when it falls due",
                control: "Take the agent off at any time; the payment is undone",
                errorStory: "Agent pays an old policy → £120 to recover" } }
    ]
  };
  const VARIANT_LABELS = ["A", "B", "C", "D"];

  // Latin-square assignment. Within a domain the four cells are ordered veto/participant,
  // veto/platform, initiation/participant, initiation/platform; the variant is that index plus a
  // per-participant, per-domain offset, modulo four.
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

  function scenarioShell(c) {
    const offset = c.domain === "investing"
      ? hash32(`${participantId}|variant-investing-v3`) % 4
      : hash32(`${participantId}|variant-payments-v3`) % 4;
    return VARIANT_LABELS[(cellIndexInDomain(c) + offset) % 4];
  }

  function currentCell() {
    return CELLS[SEQUENCES[sequenceId][state.trialCursor]];
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
      trialDecision: renderTrialDecision,
      attention: renderAttention,
      checks: renderChecks,
      demand: renderDemand,
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
      <p class="lede">Imagine you have investment and payment accounts. You will choose whether to accept AI agents that watch each account and can act on your behalf.</p>
      <p class="compact-copy">All accounts, money, and AI agents are pretend. Takes about 7 minutes. This is not financial advice.</p>
      ${IS_PILOT ? `<div class="notice" style="border-color: #7c3aed; background: transparent; text-align: left;">
        <strong style="color: #7c3aed;">Pilot run — not part of the study results.</strong>
        <p class="compact-copy" style="margin: 6px 0 0;">You were invited directly. Your answers help check
        the wording and the timing, and are excluded from the analysis.</p>
      </div>` : ""}
      <h2 style="margin-top: 22px;">Before you begin</h2>
      <ul class="muted compact-copy" style="margin: 0 0 12px; padding-left: 20px; text-align: left;">
        <li><strong>Taking part is your choice.</strong> You can close this page at any time, no questions asked,
        and it will not affect you on the platform you came from.</li>
        <li><strong>What we record:</strong> the choices you make, your answers, and how long each page takes.
        Nothing else.</li>
        <li><strong>We never ask for</strong> your name, your real financial details, or any account login.
        ${IS_PILOT
          ? `Because the researcher invited you personally, he may be able to work out which answers are
             yours. Your responses are used to check that the task is clear and to time it — they are
             <strong>not</strong> part of the study's results.`
          : `Your answers are linked only to your anonymous ID.`}</li>
        <li><strong>Your payment does not depend on your answers.</strong> There is no bonus and no right answer.</li>
        <li><strong>Changed your mind later?</strong> Send your ID to the contact below within
        ${CONSENT.withdrawalDays} days and we will delete your answers.</li>
        <li><strong>Who is running this:</strong> ${esc(CONSENT.researcher)}
        (<a href="mailto:${esc(CONSENT.email)}">${esc(CONSENT.email)}</a>). Questions or complaints go to the
        same address.</li>
        ${ethicsLine}
        ${CONSENT.controller && CONSENT.storedWhere && CONSENT.retention
          ? `<li><strong>Your data:</strong> held by ${esc(CONSENT.controller)}, stored on
             ${esc(CONSENT.storedWhere)}, kept for ${esc(CONSENT.retention)}. You can ask for a copy or ask us
             to delete it using the address above.</li>`
          : ""}
        <li>About <strong>7 minutes</strong>. You must be 18 or over.</li>
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
    bind("continue", "click", () => { state.page = "brief"; render(); });
  }

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
          <div class="mini-flow"><span>Agent detects crisis</span><b>→</b><span>Agent acts</span></div>
        </div>
      </div>
      <p class="compact-copy">You will see 8 proposed AI agents for different pretend accounts. <strong>Some agents will be described as using your instructions. Others will be described as using Fenrowe's instructions (the AI platform).</strong></p>
      <p class="compact-copy"><strong>Fenrowe</strong> = the made-up AI platform name for this study. Each agent uses AI to decide when to act.</p>
      <div class="notice">There is no right or wrong answer. We want your own view, and nothing you choose affects your payment.</div>
      <button class="primary" id="continue">Show first choice</button>
    `, "Instructions");
    bind("continue", "click", () => { state.page = "trialDecision"; state.trialStartMs = Date.now(); render(); });
  }

  function provenanceLabel(c) {
    return c.provenance === "participant" ? "Pretend: You gave the agent its instructions" : "Pretend: Fenrowe gave the agent its instructions";
  }

  function ruleDetails(c, shell) {
    const variant = SCENARIOS[c.domain][VARIANT_LABELS.indexOf(shell)];
    const arm = variant[c.authority];
    return { title: variant.title, context: variant.context,
             trigger: arm.trigger, action: arm.action, control: arm.control,
             errorStory: arm.errorStory };
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
      <span class="eyebrow">Choice ${state.trialCursor + 1} of 8</span>
      ${progressDots()}
      <h1>${esc(detail.title)}</h1>
      <p class="context-line">${esc(detail.context)}</p>
      ${firstCardNotice}
      <div class="source-banner ${c.provenance}" aria-label="Rule source">
        <span class="source-mark" aria-hidden="true">${c.provenance === "participant" ? "YOU" : "F"}</span>
        <div><small>Who created the instructions</small><strong>${esc(provenanceLabel(c))}</strong></div>
      </div>
      <p style="margin: 1rem 0 0.5rem 0; font-weight: 600;">If you accept this agent, here's how it works:</p>
      <div class="rule-flow" aria-label="How the agent works">
        <div class="flow-node"><small>What agent watches for</small><strong>${esc(detail.trigger)}</strong></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="flow-node action"><small>Action</small><strong>${esc(detail.action)}</strong></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="flow-node control"><small>Your control</small><strong>${esc(detail.control)}</strong></div>
      </div>
      <div class="error-warning" style="background: #fef3e8; border-left: 3px solid #f59e0b; padding: 0.75rem; margin: 1rem 0; border-radius: 4px;">
        <div style="display: flex; align-items: start; gap: 0.5rem;">
          <span style="font-size: 1.25rem;" aria-hidden="true">⚠️</span>
          <div>
            <strong style="display: block; margin-bottom: 0.25rem;">If agent makes a mistake:</strong>
            <span style="color: #92400e;">${esc(detail.errorStory)}</span>
          </div>
        </div>
      </div>
      <h2 class="decision-question">Accept this AI agent?</h2>
      <div class="choice-grid">
        <button class="choice-button" id="accept">Accept agent</button>
        <button class="choice-button" id="decline">Decline agent</button>
      </div>
    `, `Choice ${state.trialCursor + 1} of 8`);
    const choose = adopted => {
      state.trials.push({
        trialIndex: state.trialCursor,
        cellId: c.id,
        authority: c.authority,
        provenance: c.provenance,
        domain: c.domain,
        scenarioShell: shell,
        adopted,
        decisionMs: Date.now() - state.trialStartMs
      });
      state.trialCursor += 1;
      if (state.trialCursor === 4) state.page = "attention";
      else if (state.trialCursor === 8) state.page = "checks";
      else { state.page = "trialDecision"; state.trialStartMs = Date.now(); }
      render();
    };
    bind("accept", "click", () => choose(true));
    bind("decline", "click", () => choose(false));
  }

  function renderAttention() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">Reading check</span><h1>A quick instruction</h1>
      <fieldset><legend>To show that you read this instruction, select "Somewhat disagree."</legend>
        ${radio("attention", "agree", "Agree")}${radio("attention", "neutral", "Neither")}${radio("attention", "disagree", "Somewhat disagree")}
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
      state.attentionPass = answer === "disagree";
      state.page = "trialDecision"; state.trialStartMs = Date.now(); render();
    });
  }

  function radio(name, value, label) { return `<label class="radio"><input type="radio" name="${name}" value="${value}"> ${label}</label>`; }
  function checked(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value || null; }

  function renderChecks() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">Quick check</span><h1>Three last questions</h1>
      <p class="compact-copy">These questions check you understood the key ideas:</p>
      <fieldset><legend>What does an agent that "blocks your action" do?</legend>
        ${radio("authority", "correct", "Stops me from doing something I tried to do")}
        ${radio("authority", "wrong", "Does something before I try to do anything")}
      </fieldset>
      <fieldset><legend>When a card said "You gave the agent its instructions"...</legend>
        ${radio("provenance", "correct", "I was described as creating those instructions")}
        ${radio("provenance", "wrong", "Fenrowe was described as creating those instructions")}
      </fieldset>
      <fieldset><legend>If an agent blocks my sell order, what must I do to sell?</legend>
        ${radio("terminality", "correct", "Remove the agent and place a new sell order")}
        ${radio("terminality", "wrong", "Wait - the original order will go through automatically later")}
      </fieldset>
      <div id="checks-error" style="display: none; color: #dc2626; margin: 0.5rem 0; padding: 0.5rem; background: #fef2f2; border-radius: 4px; border-left: 3px solid #dc2626;">Please answer all three questions before continuing.</div>
      <button class="primary" id="continue">Continue</button>
    `, "Understanding checks");
    bind("continue", "click", () => {
      for (const key of ["authority", "provenance", "terminality"]) {
        if (!checked(key)) {
          document.getElementById("checks-error").style.display = "block";
          return;
        }
      }
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
  // the manipulation easier to spot. Asking directly turns an unmeasured threat into a measured one:
  // the proportion who identify it is reported, and a preregistered sensitivity analysis re-runs the
  // contrasts without them.
  //
  // Both items are closed. A free-text box here would collect whatever a participant chose to type,
  // which is how identifying information ends up in a dataset that promises it holds none.
  //
  // It runs AFTER the comprehension checks so that asking about repeats cannot prompt the answers to
  // those, and after every adoption choice so it cannot change what it measures.
  function renderDemand() {
    show(`
      ${phaseIndicator(3, 4, "Checks")}
      <span class="eyebrow">Last two questions</span><h1>About the task</h1>
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
      const repeats = checked("repeats"), guess = checked("guess");
      if (!repeats || !guess) {
        document.getElementById("demand-error").style.display = "block";
        return;
      }
      state.demand = { repeats, guess };
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
      <div class="choice-grid">
        <button class="choice-button" id="useData">Yes, include my responses in research</button>
        <button class="choice-button" id="noData">No, exclude my responses from research</button>
      </div>
    `, "Last step");
    const complete = async dataUseOk => {
      state.dataUseOk = dataUseOk;
      state.record = buildRecord();
      persistLocal(state.record);
      state.uploaded = await sendRecord(state.record);
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
      participantId,
      prolificStudyId,
      prolificSessionId,
      sequenceId,
      assignmentVersion: ASSIGNMENT_VERSION,
      source: SOURCE,
      dataUseOk: state.dataUseOk,
      startedAt: state.startedAt,
      completedAt,
      durationMs: Date.now() - state.startedMs,
      attentionPass: state.attentionPass,
      checks: state.checks,
      demand: state.demand,
      trials: state.trials,
      completionCode: completionCode(participantId)
    };
  }

  function persistLocal(record) {
    const key = "authoredBrakeEmpiricalRecords";
    let records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) { records = []; }
    records.push(record);
    localStorage.setItem(key, JSON.stringify(records));
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
      // rather than lost. The participant still gets a completion code either way: their payment
      // must never depend on our collector.
      record.uploadError = String(error);
      persistLocal(record);
      return false;
    }
  }

  function completionCode(pid) { return `AB-${hash32(`${pid}|complete-v1`).toString(36).toUpperCase().padStart(7, "0").slice(0, 7)}`; }

  function renderDebrief() {
    const r = state.record;
    const json = JSON.stringify(r, null, 2);
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    show(`
      ${phaseIndicator(4, 4, "Complete")}
      <span class="eyebrow">Complete</span><h1>Thank you</h1>

      <p><strong>What this study was about:</strong></p>
      <p>We're researching how people decide whether to accept AI agents that can either block their actions or act on their behalf, and whether it matters who created the agent's instructions.</p>

      <p><strong>What was pretend:</strong></p>
      <ul style="margin: 0.5rem 0 1rem 1.5rem;">
        <li>All accounts and money amounts</li>
        <li>Fenrowe, and every AI agent described — no real AI or platform acted</li>
        <li>The "you created" vs "Fenrowe created" attributions. Every rule shown was written by the researcher; describing some as yours was an experimental manipulation to see whether it changed your choice.</li>
      </ul>

      <p><strong>What was real:</strong></p>
      <ul style="margin: 0.5rem 0 1rem 1.5rem;">
        <li>Your choices and decisions</li>
      </ul>

      <div class="notice">Completion code: <code>${esc(r.completionCode)}</code></div>
      ${!DATA_ENDPOINT
        ? `<p class="warning notice">This test build has no collector configured. Download the record and send it to the researcher.</p><p><a class="button primary" download="${esc(r.completionCode)}.json" href="${blobUrl}">Download response record</a></p>`
        : state.uploaded === false
          ? `<p class="warning notice"><strong>Your answers could not be uploaded.</strong> This is our problem, not yours.
             <strong>Your completion code above is valid and you will be paid in full.</strong> If you would like your
             answers to count towards the research, download the file below and send it to
             ${esc(CONSENT.email)} — but you do not have to.</p>
             <p><a class="button primary" download="${esc(r.completionCode)}.json" href="${blobUrl}">Download response record</a></p>`
          : ""}
      ${COMPLETION_URL && !IS_PILOT
        ? `<p><a class="button primary" href="${esc(COMPLETION_URL)}">Return to Prolific</a></p>`
        : ""}
      ${IS_PILOT ? `<p class="muted compact-copy">That is everything — you can close this page. Thank you for
        helping check the wording; if anything read oddly, tell the researcher directly.</p>` : ""}
    `, "Complete");
    window.__AB_COMPLETE__ = r;
  }

  window.__AB_APP__ = {
    CELLS, SEQUENCES, sequenceId,
    testMode: TEST_MODE,
    consent: CONSENT,
    consentGaps,
    getState: () => state,
    hash32,
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
    return { cells: 8, sequences: 16, positionBalanced: true, predecessorBalanced: true };
  }

  validateDesign(CELLS, SEQUENCES);
  render();
})();
