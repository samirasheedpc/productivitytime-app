const state = {
  data: { team: [], areas: [], goals: [] },
  repo: { repoUrl: "", branch: "main", initialized: false, remote: "", currentBranch: "" },
  page: "goals",
  view: "active"
};

function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const $ = (selector) => document.querySelector(selector);

const fields = {
  title: $("#titleInput"),
  date: $("#dateInput"),
  time: $("#timeInput"),
  timezone: $("#timezoneInput"),
  area: $("#areaInput"),
  assignees: $("#assigneesInput"),
  notes: $("#notesInput")
};

let lastDataHash = "";

function openModal(title, text) {
  $("#modalTitle").textContent = title || "Details";
  $("#modalBody").textContent = text || "";
  $("#viewModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#viewModal").hidden = true;
  document.body.style.overflow = "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function goalAreas(goal) {
  if (Array.isArray(goal.areas)) return goal.areas;
  if (goal.area) return [goal.area];
  return [];
}

function allTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === "function") return Intl.supportedValuesOf("timeZone");
  } catch (error) {
    // fall through to a small default set
  }
  return [
    "UTC", "America/Chicago", "America/New_York", "America/Los_Angeles", "America/Denver",
    "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Dubai",
    "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"
  ];
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (error) {
    return "UTC";
  }
}

// Wall-clock time in a named zone -> the absolute instant (DST-correct for that date).
function zonedToInstant(dateStr, timeStr, tz) {
  if (!dateStr || !timeStr || !tz) return null;
  const naiveUTC = Date.parse(`${dateStr}T${timeStr}:00Z`);
  if (Number.isNaN(naiveUTC)) return null;
  try {
    const localStr = new Date(naiveUTC).toLocaleString("en-US", { timeZone: tz });
    const utcStr = new Date(naiveUTC).toLocaleString("en-US", { timeZone: "UTC" });
    const offset = Date.parse(localStr) - Date.parse(utcStr);
    if (Number.isNaN(offset)) return null;
    return new Date(naiveUTC - offset);
  } catch (error) {
    return null; // invalid IANA zone typed into the free-text field
  }
}

function dateInZone(instant, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(instant);
    const get = (type) => (parts.find((part) => part.type === type) || {}).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch (error) {
    return "";
  }
}

function dayDelta(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return 0;
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

function formatInZone(instant, tz) {
  try {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false
    }).format(instant);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", timeZoneName: "short"
    }).formatToParts(instant);
    const abbr = (parts.find((part) => part.type === "timeZoneName") || {}).value || "";
    return { time, abbr };
  } catch (error) {
    return { time: "—", abbr: "" };
  }
}

function timezoneTargets(goal) {
  const tzMap = state.data.memberTimezones || {};
  const targets = [];
  for (const person of state.data.team) {
    if (tzMap[person]) targets.push({ label: person, tz: tzMap[person] });
  }
  const myTz = localTimeZone();
  if (!targets.some((target) => target.tz === myTz)) targets.push({ label: "You", tz: myTz });
  if (!targets.length && goal.timeZone) targets.push({ label: "Source", tz: goal.timeZone });
  return targets;
}

function renderGoalTimes(container, goal) {
  container.innerHTML = "";
  if (!goal.time || !goal.timeZone) return;
  const instant = zonedToInstant(goal.date, goal.time, goal.timeZone);
  if (!instant) return;
  for (const { label, tz } of timezoneTargets(goal)) {
    const { time, abbr } = formatInZone(instant, tz);
    const delta = dayDelta(goal.date, dateInZone(instant, tz));
    const dayTag = delta > 0 ? ` (+${delta}d)` : delta < 0 ? ` (${delta}d)` : "";
    const chip = document.createElement("span");
    chip.className = "timeChip";
    const name = document.createElement("strong");
    name.textContent = label;
    const value = document.createElement("span");
    value.textContent = ` ${time}${abbr ? ` ${abbr}` : ""}${dayTag}`;
    chip.append(name, value);
    container.append(chip);
  }
}

function fillTimezoneDatalist() {
  const list = $("#timezoneList");
  if (!list || list.childElementCount) return; // populate once
  for (const zone of allTimeZones()) {
    const option = document.createElement("option");
    option.value = zone;
    list.append(option);
  }
}

// --- Momentum & accountability (client) --------------------------------------

const DAY_MS = 86400000;

const INTERACTION_LABELS = {
  viewed: "Viewed",
  reacted: "Reacted",
  question: "Question",
  blocked: "Blocked",
  will_do: "Will do",
  done: "Done"
};

const QUICK_ACTIONS = [
  { status: "viewed", label: "Acknowledge" },
  { status: "question", label: "Ask question", note: true },
  { status: "blocked", label: "Mark blocked", note: true },
  { status: "will_do", label: "I'll take this" },
  { status: "done", label: "Mark done" }
];

const OUTPUT_TYPE_LIST = [
  "Idea", "Goal", "Thought", "Update", "Research", "Outreach", "Bug fix", "Shipped feature", "Reminder"
];

const OUTPUT_STATUS_LABELS = { none: "None", not_started: "Not started", in_progress: "In progress", shipped: "Shipped" };

function me() {
  // Identity is per-device (this browser), not per-server, so three founders
  // sharing ONE hosted server each keep their own identity. Set on login.
  try {
    return localStorage.getItem("pt_user") || "";
  } catch (error) {
    return "";
  }
}

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function snippetText(text, max = 80) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function timeAgo(iso) {
  const then = parseTime(iso);
  if (!then) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function localDay(iso) {
  const t = iso ? parseTime(iso) : Date.now();
  const d = new Date(t || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hasAnyInteraction(record) {
  return Object.values(record.interactions || {}).some((i) => i && i.status);
}

function goalDeadline(goal) {
  if (goal.time && goal.timeZone) {
    const inst = zonedToInstant(goal.date, goal.time, goal.timeZone);
    if (inst) return inst.getTime();
  }
  const end = Date.parse(`${goal.date}T23:59:59`);
  return Number.isNaN(end) ? 0 : end;
}

function staleLabelsForGoal(goal) {
  const labels = [];
  if (goal.completed) return labels;
  const deadline = goalDeadline(goal);
  if (deadline && deadline < Date.now()) labels.push({ text: "Overdue", cls: "overdue" });
  if (Date.now() - parseTime(goal.updatedAt) >= DAY_MS) labels.push({ text: "Stale: needs update", cls: "stale" });
  return labels;
}

function staleLabelsForIdea(idea) {
  const labels = [];
  if (idea.status === "archived" || idea.status === "promoted") return labels;
  if (Date.now() - parseTime(idea.createdAt) >= DAY_MS && !hasAnyInteraction(idea)) {
    labels.push({ text: "Stale: needs response", cls: "stale" });
  }
  return labels;
}

function outputsToday() {
  const today = localDay();
  return (state.data.dailyOutputs || []).filter((o) => localDay(o.createdAt) === today);
}

function membersMissingOutput() {
  const posted = new Set(outputsToday().map((o) => o.ownerId));
  return (state.data.team || []).filter((m) => !posted.has(m));
}

function fillSelect(select, options, selected) {
  if (!select) return;
  const prev = selected ?? select.value;
  select.innerHTML = "";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option;
    el.textContent = option;
    select.append(el);
  }
  if (prev && options.includes(prev)) select.value = prev;
}

function renderStaleLabels(container, labels) {
  if (!container) return;
  container.innerHTML = "";
  for (const label of labels) {
    const badge = document.createElement("span");
    badge.className = `staleBadge ${label.cls}`;
    badge.textContent = label.text;
    container.append(badge);
  }
}

function renderInteractionRow(container, record) {
  if (!container) return;
  container.innerHTML = "";
  const interactions = record.interactions || {};
  for (const member of [...new Set([...state.data.team, ...FOUNDERS])]) {
    const it = interactions[member];
    const status = it && it.status;
    const chip = document.createElement("span");
    chip.className = `ackChip ack-${status || "none"}`;
    const value = document.createElement("span");
    value.textContent = ` ${status ? INTERACTION_LABELS[status] || status : "No response"}`;
    chip.append(founderTag(member), value);
    if (it && it.note) chip.title = it.note;
    container.append(chip);
  }
}

function renderQuickActions(container, record, targetType) {
  if (!container) return;
  container.innerHTML = "";
  const mine = (record.interactions || {})[me()];
  for (const action of QUICK_ACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quickAction";
    btn.textContent = action.label;
    if (mine && mine.status === action.status) btn.classList.add("active");
    btn.addEventListener("click", () => interact(targetType, record.id, action.status, action.note));
    container.append(btn);
  }
}

async function interact(targetType, recordId, status, askNote) {
  const member = me();
  if (!member) {
    alert("Log in first.");
    state.page = "settings";
    render();
    return;
  }
  const note = askNote ? prompt("Add a note (optional):") || "" : "";
  await api(`/api/${targetType === "idea" ? "ideas" : "goals"}/${recordId}/interact`, {
    method: "POST",
    body: JSON.stringify({ member, status, note })
  });
  await load();
}

function renderOutputs() {
  const strip = $("#outputStatusStrip");
  strip.innerHTML = "";
  const today = outputsToday();
  for (const member of state.data.team) {
    const has = today.some((o) => o.ownerId === member);
    const chip = document.createElement("span");
    chip.className = `statusChip ${has ? "ok" : "missing"}`;
    chip.textContent = has ? `${member}: posted ✓` : `${member}: No output today`;
    strip.append(chip);
  }
  $("#outputSummary").textContent = `${today.length} output${today.length === 1 ? "" : "s"} today · ${membersMissingOutput().length} missing`;

  const as = $("#outputAs");
  if (as) {
    as.innerHTML = "";
    if (me()) {
      as.append(document.createTextNode("Posting as "), founderTag(me()));
    } else {
      as.textContent = "Log in to post your output.";
    }
  }

  const list = $("#outputList");
  list.innerHTML = "";
  if (!today.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No outputs posted today. Each teammate should post one.";
    list.append(empty);
    return;
  }
  for (const output of today) list.append(renderOutputCard(output));
}

function renderOutputCard(output) {
  const card = document.createElement("div");
  card.className = `outputCard out-${output.status}`;

  const head = document.createElement("div");
  head.className = "outputHead";
  head.append(founderTag(output.ownerId));
  if (output.type) {
    const type = document.createElement("span");
    type.className = "outputType";
    type.textContent = output.type;
    head.append(type);
  }

  const desc = document.createElement("p");
  desc.className = "outputDesc";
  desc.textContent = output.description;
  card.append(head, desc);

  if (output.notes) {
    const notes = document.createElement("p");
    notes.className = "outputNotes muted";
    notes.textContent = output.notes;
    card.append(notes);
  }

  const foot = document.createElement("div");
  foot.className = "outputFoot";

  const statusSel = document.createElement("select");
  statusSel.className = "outputStatusSel";
  for (const value of Object.keys(OUTPUT_STATUS_LABELS)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = OUTPUT_STATUS_LABELS[value];
    if (output.status === value) opt.selected = true;
    statusSel.append(opt);
  }
  statusSel.addEventListener("change", async () => {
    await api(`/api/outputs/${output.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: statusSel.value, actor: me() })
    });
    await load();
  });

  const when = document.createElement("span");
  when.className = "muted";
  when.textContent = timeAgo(output.createdAt);

  const del = document.createElement("button");
  del.className = "deleteGoal";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (!confirm("Delete this output?")) return;
    await api(`/api/outputs/${output.id}`, { method: "DELETE" });
    await load();
  });

  foot.append(statusSel, when, del);
  card.append(foot);
  const replies = document.createElement("div");
  replies.className = "repliesBox";
  card.append(replies);
  renderReplies(replies, output, "output");
  return card;
}

async function addCurrentOutput() {
  const owner = me();
  const desc = $("#outputDesc").value.trim();
  if (!owner) {
    alert("Log in first (lock button) so the output posts under your name.");
    return;
  }
  if (!desc) return;
  await api("/api/outputs", {
    method: "POST",
    body: JSON.stringify({
      ownerId: owner,
      type: $("#outputType").value.trim(),
      description: desc,
      status: $("#outputStatus").value,
      notes: $("#outputNotes").value
    })
  });
  $("#outputDesc").value = "";
  $("#outputNotes").value = "";
  $("#outputType").value = "";
  $("#outputStatus").value = "none";
  await load();
}

function renderActivity() {
  const feed = $("#activityFeed");
  feed.innerHTML = "";
  const items = (state.data.activity || []).slice(0, 25);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No activity yet.";
    feed.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "activityItem";
    const msg = document.createElement("span");
    msg.className = "activityMsg";
    let text = item.message || item.type;
    if (item.actorId) {
      msg.append(founderTag(item.actorId), document.createTextNode(" "));
      if (text.startsWith(`${item.actorId} `)) text = text.slice(item.actorId.length + 1);
    }
    msg.append(document.createTextNode(text));
    const when = document.createElement("span");
    when.className = "muted activityTime";
    when.textContent = timeAgo(item.createdAt);
    row.append(msg, when);
    feed.append(row);
  }
}

function buildAccountabilityPrompt() {
  const today = localDay();
  const active = state.data.goals.filter((g) => !g.completed);
  const outs = outputsToday();
  const staleGoals = active.filter((g) => staleLabelsForGoal(g).some((l) => l.cls === "stale"));
  const overdue = active.filter((g) => staleLabelsForGoal(g).some((l) => l.cls === "overdue"));
  const staleIdeas = (state.data.ideas || []).filter((i) => staleLabelsForIdea(i).length);
  const missing = membersMissingOutput();
  const unanswered = active.filter((g) => !hasAnyInteraction(g));

  const bullet = (arr, fmt) => (arr.length ? arr.map(fmt).join("\n") : "- none");
  return [
    `Team accountability snapshot for ${today} (ProductivityTime).`,
    "",
    "TODAY'S OUTPUTS:",
    bullet(outs, (o) => `- ${o.ownerId}: [${o.type}] ${o.description} (${o.status.replace("_", " ")})`),
    "",
    "MISSING OUTPUT TODAY:",
    bullet(missing, (m) => `- ${m}`),
    "",
    "OVERDUE GOALS:",
    bullet(overdue, (g) => `- ${snippetText(g.title)}`),
    "",
    "STALE GOALS (no update 24h+):",
    bullet(staleGoals, (g) => `- ${snippetText(g.title)}`),
    "",
    "STALE IDEAS (no response 24h+):",
    bullet(staleIdeas, (i) => `- ${snippetText(i.text)}`),
    "",
    "GOALS WITH NO TEAMMATE ACKNOWLEDGEMENT:",
    bullet(unanswered, (g) => `- ${snippetText(g.title)}`),
    "",
    "Write a short, direct team accountability message (5-8 lines) for Sami, Reyan, and Ahnaf: call out who shipped, what is stale or overdue, who still owes today's output, and one concrete next action per person. Motivating but honest about silence."
  ].join("\n");
}

// --- Founder login + replies + daily momentum --------------------------------

const FOUNDERS = ["Sami", "Reyan", "Ahnaf"];

// A goal assigned to all three founders is a shared, required task: it can't be
// completed until every founder has signed off (their interaction status="done").
function goalRequiresAllFounders(goal) {
  const assignees = goal.assignees || [];
  return FOUNDERS.every((f) => assignees.includes(f));
}

function isFounderDone(goal, founder) {
  const it = (goal.interactions || {})[founder];
  return Boolean(it && it.status === "done");
}

function foundersPendingSignoff(goal) {
  return FOUNDERS.filter((f) => !isFounderDone(goal, f));
}

// A founder's name rendered as a green-on-black terminal tag (clear attribution).
function founderTag(name) {
  const tag = document.createElement("span");
  tag.className = "founderTag";
  tag.textContent = name || "?";
  return tag;
}

async function doLogin() {
  // No password — just pick who you are. The real gate is your GitHub account
  // (the allowlist check below), not a shared password.
  const who = $("#loginName") ? $("#loginName").value : "";
  const err = $("#loginError");
  if (!who) {
    err.textContent = "pick your name";
    return;
  }
  // First run on a device needs a GitHub token (it's how saves reach the repo).
  const tokenField = $("#loginToken");
  if (tokenField && tokenField.value.trim()) window.PTStore.setToken(tokenField.value.trim());
  if (!window.PTStore.hasToken()) {
    err.textContent = "Paste your GitHub token to connect (see Settings link below).";
    return;
  }
  // Only the three founders' GitHub accounts are allowed in.
  err.textContent = "checking access…";
  try {
    await window.PTStore.verifyAccount();
  } catch (error) {
    err.textContent = error.message || "This GitHub account isn't authorized.";
    return;
  }
  err.textContent = "";
  if (tokenField) tokenField.value = "";
  try { localStorage.setItem("pt_user", who); } catch (error) { /* private mode */ }
  try {
    await load();
  } catch (error) {
    err.textContent = error.message || "Could not connect to GitHub.";
    try { localStorage.removeItem("pt_user"); } catch (e) {}
  }
}

async function logout() {
  try { localStorage.removeItem("pt_user"); } catch (error) { /* private mode */ }
  await load();
}

const replyPath = (targetType) =>
  targetType === "idea" ? "ideas" : targetType === "output" ? "outputs" : "goals";

function renderReplies(container, record, targetType) {
  if (!container) return;
  container.innerHTML = "";
  for (const reply of record.replies || []) {
    const row = document.createElement("div");
    row.className = "replyRow";
    row.append(founderTag(reply.author));
    const text = document.createElement("span");
    text.className = "replyText";
    text.textContent = reply.text;
    const when = document.createElement("span");
    when.className = "muted replyTime";
    when.textContent = timeAgo(reply.createdAt);
    row.append(text, when);
    container.append(row);
  }
  const form = document.createElement("div");
  form.className = "replyForm";
  const input = document.createElement("input");
  input.className = "replyInput";
  input.placeholder = me() ? `reply as ${me()}…` : "log in to reply";
  input.disabled = !me();
  const btn = document.createElement("button");
  btn.className = "replyBtn";
  btn.textContent = "reply";
  btn.disabled = !me();
  const submit = async () => {
    const text = input.value.trim();
    if (!text || !me()) return;
    await api(`/api/${replyPath(targetType)}/${record.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ author: me(), text })
    });
    input.value = "";
    await load();
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  form.append(input, btn);
  container.append(form);
}

// Distinct OTHER founders that `member` has replied to today (toward the ≥2 rule).
function repliesTodayBy(member) {
  const today = localDay();
  const recipients = new Set();
  const all = [...state.data.goals, ...state.data.ideas, ...(state.data.dailyOutputs || []), ...(state.data.questions || [])];
  for (const record of all) {
    for (const reply of record.replies || []) {
      if (reply.author === member && localDay(reply.createdAt) === today && reply.to && reply.to !== member) {
        recipients.add(reply.to);
      }
    }
  }
  return recipients.size;
}

function renderRequirements() {
  const board = $("#requirementsBoard");
  if (!board) return;
  board.innerHTML = "";
  const today = outputsToday();
  for (const member of state.data.team) {
    const hasOutput = today.some((o) => o.ownerId === member);
    const replyCount = repliesTodayBy(member);
    const card = document.createElement("div");
    card.className = `reqCard ${hasOutput && replyCount >= 2 ? "reqDone" : "reqPending"}`;
    const head = document.createElement("div");
    head.className = "reqHead";
    head.append(founderTag(member));
    const out = document.createElement("span");
    out.className = `reqItem ${hasOutput ? "ok" : "bad"}`;
    out.textContent = hasOutput ? "output ✓" : "output ✗ (0/1)";
    const rep = document.createElement("span");
    rep.className = `reqItem ${replyCount >= 2 ? "ok" : "bad"}`;
    rep.textContent = `replies ${replyCount}/2`;
    card.append(head, out, rep);
    board.append(card);
  }
}

// Serverless: route the old /api/* calls straight to GitHub via PTStore (store.js)
// instead of a local Node server. Same call sites, same return shapes.
async function api(path, options = {}) {
  return window.PTStore.request(path, options);
}

async function load() {
  state.data = await api("/api/goals");
  state.repo = await api("/api/repo");
  lastDataHash = JSON.stringify(state.data);
  render();
}

// Live updates: poll the shared data and re-render when a teammate's change
// arrives — but never clobber a field you're actively editing.
async function pollData() {
  if (!me()) return; // don't churn behind the login gate
  let data;
  try {
    data = await api("/api/goals");
  } catch (error) {
    return;
  }
  const hash = JSON.stringify(data);
  if (hash === lastDataHash) return;

  const active = document.activeElement;
  const focused =
    active &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) &&
    active.closest(".shell");
  const menuOpen = document.querySelector(".multiSelectMenu:not([hidden])");
  if (focused || menuOpen) return; // don't clobber an in-progress edit or open picker

  lastDataHash = hash;
  state.data = data;
  render();
}

function render() {
  const active = state.data.goals.filter((goal) => !goal.completed);
  const completed = state.data.goals.filter((goal) => goal.completed);
  $("#summary").textContent = `${active.length} active, ${completed.length} completed`;

  fillDatalist("#areasList", state.data.areas);
  fillDatalist("#teamList", state.data.team);
  fillTimezoneDatalist();
  setupMultiSelect(fields.area, state.data.areas, getMultiSelectValues(fields.area));
  setupMultiSelect(fields.assignees, state.data.team, getMultiSelectValues(fields.assignees));

  const page = state.page;
  document.querySelectorAll(".appTab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.page === page);
  });
  $("#mainView").hidden = page === "settings";
  $("#settingsSection").hidden = page !== "settings";
  $("#requirementsSection").hidden = page !== "goals";
  $("#outputSection").hidden = page !== "goals";
  $("#goalsSection").hidden = page !== "goals";
  $("#completedSection").hidden = page !== "completed";
  $("#calendarSection").hidden = page !== "calendar";
  $("#ideasSection").hidden = page !== "ideas";
  $("#questionsSection").hidden = page !== "questions";
  $("#activitySection").hidden = page !== "changes";

  renderSettings();
  renderFocus();
  renderIdeas();
  renderQuestions();
  renderCalendar();
  renderOutputs();
  renderActivity();
  renderRequirements();

  // Founder login gate + identity display in the top bar.
  $("#loginOverlay").hidden = Boolean(me());
  if (!me()) $("#loginName").focus();
  $("#identityBanner").hidden = true;
  const whoami = $("#whoami");
  whoami.innerHTML = "";
  $("#lockButton").hidden = !me();
  if (me()) {
    whoami.append(document.createTextNode("you: "), founderTag(me()));
  }

  const byDate = (a, b) => `${a.date}${a.title}`.localeCompare(`${b.date}${b.title}`);
  const byCompleted = (a, b) => parseTime(b.completedAt) - parseTime(a.completedAt) || byDate(a, b);
  renderGoalList($("#goalList"), [...active].sort(byDate), "No active goals yet.");
  renderGoalList($("#completedList"), [...completed].sort(byCompleted), "Nothing completed yet.");
}

// For a goal assigned to all three founders, show a sign-off strip (who has
// marked done) and gate the Complete button until everyone has signed off.
function renderSignoff(node, goal, completeBtn) {
  if (!goalRequiresAllFounders(goal)) return;
  const row = document.createElement("div");
  row.className = "signoffRow";

  const badge = document.createElement("span");
  badge.className = "requiredBadge";
  badge.textContent = "All-founder task";
  row.append(badge);

  for (const f of FOUNDERS) {
    const done = isFounderDone(goal, f);
    const chip = document.createElement("span");
    chip.className = `signoffChip ${done ? "done" : "pending"}`;
    chip.append(founderTag(f));
    const mark = document.createElement("span");
    mark.textContent = done ? " ✓ done" : " ⏳ pending";
    chip.append(mark);
    row.append(chip);
  }

  // The logged-in founder can toggle their own sign-off right here.
  if (FOUNDERS.includes(me()) && !goal.completed) {
    const mine = isFounderDone(goal, me());
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "signoffToggle";
    toggle.textContent = mine ? "Undo my sign-off" : "Sign off as done";
    toggle.addEventListener("click", () => interact("goal", goal.id, mine ? "viewed" : "done"));
    row.append(toggle);
  }

  if (!goal.completed) {
    const pending = foundersPendingSignoff(goal);
    if (pending.length) {
      completeBtn.disabled = true;
      completeBtn.title = `Needs sign-off from: ${pending.join(", ")}`;
    }
  }

  node.querySelector(".staleLabels").after(row);
}

// Build one fully-wired goal card (used for both the active and completed lists,
// so completed goals keep full edit / delete / reopen actions).
function buildGoalCard(goal) {
  const node = $("#goalTemplate").content.firstElementChild.cloneNode(true);
  const title = node.querySelector(".goalTitle");
  const notes = node.querySelector(".goalNotes");
  const date = node.querySelector(".goalDate");
  const time = node.querySelector(".goalTime");
  const timezone = node.querySelector(".goalTimezone");
  const times = node.querySelector(".goalTimes");
  const areaSelect = node.querySelector(".goalArea");
  const assigneeSelect = node.querySelector(".goalAssignees");
  const complete = node.querySelector(".completeGoal");

  title.value = goal.title;
  notes.value = goal.notes || "";
  date.value = goal.date;
  time.value = goal.time || "";
  timezone.value = goal.timeZone || "";
  renderGoalTimes(times, goal);
  title.addEventListener("input", () => autoGrow(title));
  notes.addEventListener("input", () => autoGrow(notes));
  setupMultiSelect(areaSelect, state.data.areas, goalAreas(goal));
  setupMultiSelect(assigneeSelect, state.data.team, goal.assignees);
  complete.textContent = goal.completed ? "Reopen" : "Complete";
  renderStaleLabels(node.querySelector(".staleLabels"), staleLabelsForGoal(goal));
  renderSignoff(node, goal, complete);
  renderInteractionRow(node.querySelector(".interactionRow"), goal);
  renderQuickActions(node.querySelector(".quickActions"), goal, "goal");
  renderReplies(node.querySelector(".repliesBox"), goal, "goal");

  node.querySelector(".saveGoal").addEventListener("click", async () => {
    await api(`/api/goals/${goal.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: title.value,
        notes: notes.value,
        date: date.value,
        time: time.value,
        timeZone: timezone.value,
        areas: getMultiSelectValues(areaSelect),
        assignees: getMultiSelectValues(assigneeSelect)
      })
    });
    await load();
  });

  complete.addEventListener("click", async () => {
    try {
      await api(`/api/goals/${goal.id}/${goal.completed ? "reopen" : "complete"}`, {
        method: "POST",
        body: JSON.stringify({ actor: me() })
      });
      await load();
    } catch (error) {
      alert(error.message);
    }
  });

  node.querySelector(".deleteGoal").addEventListener("click", async () => {
    if (!confirm(`Delete "${goal.title}"?`)) return;
    await api(`/api/goals/${goal.id}`, { method: "DELETE" });
    await load();
  });

  return node;
}

function renderGoalList(listEl, goals, emptyText) {
  listEl.innerHTML = "";
  if (!goals.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    listEl.append(empty);
    return;
  }
  for (const goal of goals) {
    const node = buildGoalCard(goal);
    listEl.append(node);
    const title = node.querySelector(".goalTitle");
    autoGrow(title);
    autoGrow(node.querySelector(".goalNotes"));
    if (title.scrollHeight - title.clientHeight > 4) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "viewMore";
      view.textContent = "View full";
      view.addEventListener("click", () => openModal("Goal", title.value));
      title.after(view);
    }
  }
}

function fillDatalist(selector, items) {
  const list = $(selector);
  list.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item;
    list.append(option);
  }
}

async function addCurrentGoal() {
  if (!fields.title.value.trim()) return;
  await api("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title: fields.title.value,
      date: fields.date.value,
      time: fields.time.value,
      timeZone: fields.timezone.value,
      areas: getMultiSelectValues(fields.area),
      assignees: getMultiSelectValues(fields.assignees),
      notes: fields.notes.value,
      actorId: me()
    })
  });
  fields.title.value = "";
  fields.notes.value = "";
  fields.time.value = "";
  await load();
  setupMultiSelect(fields.area, state.data.areas, []);
  setupMultiSelect(fields.assignees, state.data.team, []);
}

function setupMultiSelect(host, options, selected) {
  const allowed = new Set(options);
  const current = new Set((selected || []).filter((value) => allowed.has(value)));
  host.innerHTML = "";
  host.dataset.values = JSON.stringify([...current]);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "multiSelectButton";
  button.textContent = labelForSelection(current, host.dataset.placeholder);

  const menu = document.createElement("div");
  menu.className = "multiSelectMenu";
  menu.hidden = true;

  for (const option of options) {
    const item = document.createElement("label");
    item.className = "multiSelectOption";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option;
    checkbox.checked = current.has(option);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) current.add(option);
      else current.delete(option);
      host.dataset.values = JSON.stringify([...current]);
      button.textContent = labelForSelection(current, host.dataset.placeholder);
    });

    const text = document.createElement("span");
    text.textContent = option;
    item.append(checkbox, text);
    menu.append(item);
  }

  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "multiSelectEmpty";
    empty.textContent = "Add options in Settings";
    menu.append(empty);
  }

  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });

  host.append(button, menu);
}

function getMultiSelectValues(host) {
  try {
    return JSON.parse(host.dataset.values || "[]");
  } catch {
    return [];
  }
}

function labelForSelection(selected, placeholder) {
  const values = [...selected];
  if (!values.length) return placeholder || "Choose";
  if (values.length <= 2) return values.join(", ");
  return `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

function renderSettings() {
  renderEditableList("#teamEditor", state.data.team, "team");
  renderEditableList("#areaEditor", state.data.areas, "areas");
  renderTimezoneEditor();

  const meSel = $("#currentUserSelect");
  meSel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— pick —";
  meSel.append(blank);
  for (const member of state.data.team) {
    const opt = document.createElement("option");
    opt.value = member;
    opt.textContent = member;
    meSel.append(opt);
  }
  meSel.value = me();
  $("#repoUrlInput").value = state.repo.repoUrl || state.repo.remote || "";
  $("#branchInput").value = state.repo.branch || state.repo.currentBranch || "main";
  $("#repoSummary").textContent = state.repo.remote
    ? `Connected to ${state.repo.remote} on ${state.repo.currentBranch || state.repo.branch || "main"}`
    : "Not connected yet.";

  const liveOn = Boolean(state.repo.remote) && state.repo.autoSync !== false;
  $("#autoSyncToggle").checked = state.repo.autoSync !== false;
  $("#liveIndicator").hidden = !liveOn;
}

function renderTimezoneEditor() {
  const host = $("#timezoneEditor");
  host.innerHTML = "";
  const tzMap = state.data.memberTimezones || {};
  if (!state.data.team.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Add team members first.";
    host.append(empty);
    return;
  }
  for (const person of state.data.team) {
    const row = document.createElement("div");
    row.className = "editRow tzRow";

    const name = document.createElement("span");
    name.className = "tzName";
    name.textContent = person;

    const input = document.createElement("input");
    input.setAttribute("list", "timezoneList");
    input.setAttribute("autocomplete", "off");
    input.placeholder = "e.g. America/Chicago";
    input.value = tzMap[person] || "";
    input.addEventListener("change", async () => {
      await api("/api/team/timezone", {
        method: "POST",
        body: JSON.stringify({ name: person, timeZone: input.value.trim() })
      });
      await load();
    });

    row.append(name, input);
    host.append(row);
  }
}

function renderEditableList(selector, items, kind) {
  const host = $(selector);
  host.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "editRow";

    const input = document.createElement("input");
    input.value = item;

    const save = document.createElement("button");
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      const next = input.value.trim();
      if (!next || next === item) return;
      await api(`/api/${kind}/rename`, {
        method: "POST",
        body: JSON.stringify({ from: item, to: next })
      });
      await load();
    });

    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "deleteGoal";
    remove.addEventListener("click", async () => {
      const next = items.filter((value) => value !== item);
      await api(`/api/${kind === "team" ? "team" : "areas"}`, {
        method: "PATCH",
        body: JSON.stringify(kind === "team" ? { team: next } : { areas: next })
      });
      await load();
    });

    row.append(input, save, remove);
    host.append(row);
  }
}

async function addMetadataItem(kind, value) {
  const name = value.trim();
  if (!name) return;
  if (kind === "team") {
    await api("/api/team", {
      method: "PATCH",
      body: JSON.stringify({ team: [...state.data.team, name] })
    });
  } else {
    await api("/api/areas", {
      method: "PATCH",
      body: JSON.stringify({ areas: [...state.data.areas, name] })
    });
  }
  await load();
}

const FOCUS_LABELS = { focus: "Focus", stale: "Stale", think: "Think about" };

// Daily Focus is now computed live from app data (not AI): what to focus on,
// what's stale/overdue, who owes output, what needs a response, what can ship.
function renderFocus() {
  const body = $("#focusBody");
  body.innerHTML = "";
  const active = state.data.goals.filter((g) => !g.completed);
  const today = localDay();

  const focusItems = active.filter((g) => g.date && g.date <= today).map((g) => g.title);
  const flaggedItems = active
    .filter((g) => staleLabelsForGoal(g).length)
    .map((g) => {
      const tags = staleLabelsForGoal(g).map((l) => (l.cls === "overdue" ? "Overdue" : "Stale")).join("/");
      return `${tags}: ${g.title}`;
    });
  const staleIdeas = (state.data.ideas || []).filter((i) => staleLabelsForIdea(i).length).map((i) => i.text);
  const missing = membersMissingOutput();
  const weekEnd = Date.now() + 7 * DAY_MS;
  const shipWeek = active
    .filter((g) => {
      const d = goalDeadline(g);
      return d && d <= weekEnd;
    })
    .map((g) => g.title);

  const meta = document.createElement("p");
  meta.className = "muted";
  meta.textContent = `${today} · auto-generated from your data`;
  body.append(meta);

  const groups = [
    { tag: "Focus today", cls: "focus", items: focusItems },
    { tag: "Stale / overdue", cls: "stale", items: flaggedItems },
    { tag: "No output today", cls: "stale", items: missing.map((m) => `${m} has not posted output`) },
    { tag: "Needs response", cls: "think", items: staleIdeas },
    { tag: "Ship this week", cls: "focus", items: shipWeek }
  ];

  let any = false;
  for (const group of groups) {
    const items = group.items.filter(Boolean);
    if (!items.length) continue;
    any = true;
    const wrap = document.createElement("div");
    wrap.className = `focusGroup focus-${group.cls}`;
    const tag = document.createElement("span");
    tag.className = "focusTag";
    tag.textContent = group.tag;
    const ul = document.createElement("ul");
    for (const text of items.slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = snippetText(text, 100);
      ul.append(li);
    }
    wrap.append(tag, ul);
    body.append(wrap);
  }

  if (!any) {
    const ok = document.createElement("p");
    ok.className = "muted";
    ok.textContent = "All clear — nothing stale, overdue, or missing right now.";
    body.append(ok);
  }
}

function renderIdeas() {
  const list = $("#ideaList");
  list.innerHTML = "";
  const ideas = (state.data.ideas || []).filter((idea) => idea.status !== "archived");
  const needTriage = ideas.filter((idea) => idea.status === "new").length;
  $("#ideasSummary").textContent = ideas.length
    ? `${ideas.length} idea${ideas.length === 1 ? "" : "s"} · ${needTriage} awaiting triage`
    : "";

  if (!ideas.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No ideas yet. Brain-dump anything above — your AI agent can triage it later.";
    list.append(empty);
    return;
  }

  const template = $("#ideaTemplate");
  for (const idea of ideas) {
    const node = template.content.firstElementChild.cloneNode(true);
    const status = node.querySelector(".ideaStatus");
    status.textContent = idea.status || "new";
    status.classList.add(`status-${idea.status || "new"}`);
    node.querySelector(".ideaAuthor").textContent = idea.author ? `— ${idea.author}` : "";
    const ideaTextEl = node.querySelector(".ideaText");
    ideaTextEl.textContent = idea.text;

    const triageBox = node.querySelector(".ideaTriage");
    const triage = idea.triage;
    if (triage) {
      triageBox.hidden = false;
      if (triage.summary) triageBox.append(triageRow("Summary", triage.summary));
      if (triage.kind) triageBox.append(triageRow("Kind", triage.kind));
      if (triage.suggestedGoal) {
        const areas = (triage.suggestedGoal.areas || []).join(", ");
        triageBox.append(triageRow("Suggested goal", `${triage.suggestedGoal.title}${areas ? ` (${areas})` : ""}`));
      }
      if (triage.nextSteps && triage.nextSteps.length) {
        triageBox.append(triageRow("Next", triage.nextSteps.join(" · ")));
      }
      if (triage.thoughts) triageBox.append(triageRow("Think about", triage.thoughts));
    }

    renderStaleLabels(node.querySelector(".staleLabels"), staleLabelsForIdea(idea));
    renderInteractionRow(node.querySelector(".interactionRow"), idea);
    renderQuickActions(node.querySelector(".quickActions"), idea, "idea");
    renderReplies(node.querySelector(".repliesBox"), idea, "idea");

    const promote = node.querySelector(".promoteIdea");
    if (idea.status === "promoted") {
      promote.textContent = "Promoted ✓";
      promote.disabled = true;
    }
    promote.addEventListener("click", async () => {
      await api(`/api/ideas/${idea.id}/promote`, { method: "POST", body: JSON.stringify({ actorId: me() }) });
      state.page = "goals";
      await load();
    });

    node.querySelector(".archiveIdea").addEventListener("click", async () => {
      await api(`/api/ideas/${idea.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived", actorId: me() })
      });
      await load();
    });

    node.querySelector(".deleteIdea").addEventListener("click", async () => {
      if (!confirm("Delete this idea?")) return;
      await api(`/api/ideas/${idea.id}`, { method: "DELETE" });
      await load();
    });

    list.append(node);
    if (ideaTextEl.scrollHeight - ideaTextEl.clientHeight > 4) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "viewMore";
      view.textContent = "View full";
      view.addEventListener("click", () =>
        openModal(`Idea${idea.author ? ` — ${idea.author}` : ""}`, idea.text)
      );
      ideaTextEl.after(view);
    }
  }
}

function triageRow(label, value) {
  const row = document.createElement("div");
  row.className = "triageRow";
  const key = document.createElement("span");
  key.className = "triageKey";
  key.textContent = label;
  const val = document.createElement("span");
  val.className = "triageVal";
  val.textContent = value || "—";
  row.append(key, val);
  return row;
}

// --- Questions (client) ------------------------------------------------------

function renderQuestions() {
  const list = $("#questionList");
  if (!list) return;
  list.innerHTML = "";
  const questions = state.data.questions || [];
  $("#questionsSummary").textContent = questions.length
    ? `${questions.length} open question${questions.length === 1 ? "" : "s"}`
    : "";
  if (!questions.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No questions yet. Ask the team something above.";
    list.append(empty);
    return;
  }
  const template = $("#questionTemplate");
  for (const question of questions) {
    const node = template.content.firstElementChild.cloneNode(true);
    const topic = node.querySelector(".questionTopic");
    if (question.topic) topic.textContent = question.topic;
    else topic.hidden = true;
    const authorEl = node.querySelector(".questionAuthor");
    authorEl.textContent = "";
    if (question.authorId) authorEl.append(document.createTextNode("— "), founderTag(question.authorId));
    node.querySelector(".questionText").textContent = question.text;
    renderQuestionReplies(node.querySelector(".questionReplies"), question);
    node.querySelector(".deleteQuestion").addEventListener("click", async () => {
      if (!confirm("Delete this question?")) return;
      await api(`/api/questions/${question.id}`, { method: "DELETE" });
      await load();
    });
    list.append(node);
  }
}

// Replies on a question. Everyone can reply; founders can click "Agree" on a
// specific reply, and the people who agree are shown under it.
function renderQuestionReplies(container, question) {
  if (!container) return;
  container.innerHTML = "";
  for (const reply of question.replies || []) {
    const row = document.createElement("div");
    row.className = "replyRow questionReplyRow";
    row.append(founderTag(reply.author));
    const text = document.createElement("span");
    text.className = "replyText";
    text.textContent = reply.text;
    const when = document.createElement("span");
    when.className = "muted replyTime";
    when.textContent = timeAgo(reply.createdAt);
    row.append(text, when);

    const votes = reply.agreeVotes || {};
    const agrees = Object.keys(votes).filter((m) => votes[m] && votes[m].agree);
    const iAgree = agrees.includes(me());
    const agreeBtn = document.createElement("button");
    agreeBtn.type = "button";
    agreeBtn.className = `agreeBtn${iAgree ? " active" : ""}`;
    agreeBtn.textContent = iAgree ? `Agreed ✓ (${agrees.length})` : `Agree (${agrees.length})`;
    agreeBtn.disabled = !FOUNDERS.includes(me());
    if (!FOUNDERS.includes(me())) agreeBtn.title = "Founders only";
    agreeBtn.addEventListener("click", async () => {
      await api(`/api/questions/${question.id}/agree`, {
        method: "POST",
        body: JSON.stringify({ replyId: reply.id, member: me() })
      });
      await load();
    });
    row.append(agreeBtn);
    container.append(row);

    if (agrees.length) {
      const who = document.createElement("div");
      who.className = "agreeList";
      who.append(document.createTextNode("agreed: "));
      agrees.forEach((name, i) => {
        who.append(founderTag(name));
        if (i < agrees.length - 1) who.append(document.createTextNode(" "));
      });
      container.append(who);
    }
  }

  const form = document.createElement("div");
  form.className = "replyForm";
  const input = document.createElement("input");
  input.className = "replyInput";
  input.placeholder = me() ? `reply as ${me()}…` : "log in to reply";
  input.disabled = !me();
  const btn = document.createElement("button");
  btn.className = "replyBtn";
  btn.textContent = "reply";
  btn.disabled = !me();
  const submit = async () => {
    const value = input.value.trim();
    if (!value || !me()) return;
    await api(`/api/questions/${question.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ author: me(), text: value })
    });
    input.value = "";
    await load();
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  form.append(input, btn);
  container.append(form);
}

async function addCurrentQuestion() {
  if (!me()) {
    alert("Log in first to ask a question.");
    return;
  }
  const topic = $("#questionTopic").value.trim();
  const text = $("#questionText").value.trim();
  if (!text) return;
  await api("/api/questions", {
    method: "POST",
    body: JSON.stringify({ topic, text, authorId: me() })
  });
  $("#questionTopic").value = "";
  $("#questionText").value = "";
  await load();
}

// --- Calendar (client) -------------------------------------------------------

const CT_ZONE = "America/Chicago"; // anchor for which calendar day counts as "today"

// Coloured founder identity icons: Sami=red S, Reyan=green R, Ahnaf=purple A.
const FOUNDER_ICON = {
  Sami: { letter: "S", cls: "sami" },
  Reyan: { letter: "R", cls: "reyan" },
  Ahnaf: { letter: "A", cls: "ahnaf" }
};

function founderIcon(name) {
  const span = document.createElement("span");
  const meta = FOUNDER_ICON[name];
  span.className = `founderIcon ${meta ? meta.cls : "other"}`;
  span.textContent = meta ? meta.letter : name ? name[0].toUpperCase() : "?";
  span.title = name || "";
  return span;
}

// Founders who currently agree to a proposed time (from the timestamped vote map).
function agreedMembers(slot) {
  const votes = slot.agreeVotes || {};
  return Object.keys(votes).filter((m) => votes[m] && votes[m].agree);
}

// The next `n` calendar days starting today, in Central Time, as YYYY-MM-DD.
function upcomingDaysCT(n = 7) {
  const todayCT = dateInZone(new Date(), CT_ZONE) || new Date().toISOString().slice(0, 10);
  const base = Date.parse(`${todayCT}T12:00:00Z`); // noon-UTC anchor avoids DST/offset rollover
  const days = [];
  for (let i = 0; i < n; i++) days.push(new Date(base + i * 86400000).toISOString().slice(0, 10));
  return days;
}

function dayLabel(dateStr) {
  const dt = new Date(`${dateStr}T12:00:00Z`);
  const wd = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const md = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${wd} · ${md}`;
}

function renderCalendar() {
  const wrap = $("#calendarList");
  if (!wrap) return;
  wrap.innerHTML = "";
  const days = upcomingDaysCT(7);
  const all = state.data.availability || [];
  let lockedDays = 0;

  for (const date of days) {
    const proposals = all.filter((s) => s.date === date);
    const locked = proposals.some((p) => FOUNDERS.every((f) => agreedMembers(p).includes(f)));
    if (locked) lockedDays++;

    const card = document.createElement("div");
    card.className = `calDay${locked ? " locked" : ""}`;

    const head = document.createElement("div");
    head.className = "calDayHead";
    const label = document.createElement("span");
    label.className = "calDayLabel";
    label.textContent = dayLabel(date);
    const status = document.createElement("span");
    status.className = `calDayStatus ${locked ? "ok" : "pending"}`;
    status.textContent = locked ? "✓ meeting locked" : proposals.length ? "needs all three" : "no times yet";
    head.append(label, status);
    card.append(head);

    const slotsWrap = document.createElement("div");
    slotsWrap.className = "calSlots";
    for (const p of proposals) {
      const agreed = agreedMembers(p);
      const all3 = FOUNDERS.every((f) => agreed.includes(f));
      const row = document.createElement("div");
      row.className = `calSlot${all3 ? " allThree" : ""}`;

      const timeEl = document.createElement("span");
      timeEl.className = "calTime";
      timeEl.textContent = p.text;
      row.append(timeEl);

      const who = document.createElement("span");
      who.className = "calWho";
      for (const m of agreed) who.append(founderIcon(m));
      row.append(who);

      const iAgree = agreed.includes(me());
      const agreeBtn = document.createElement("button");
      agreeBtn.type = "button";
      agreeBtn.className = `agreeBtn${iAgree ? " active" : ""}`;
      agreeBtn.textContent = iAgree ? `Agreed ✓ (${agreed.length})` : `Agree (${agreed.length})`;
      agreeBtn.disabled = !FOUNDERS.includes(me());
      if (!FOUNDERS.includes(me())) agreeBtn.title = "Founders only";
      agreeBtn.addEventListener("click", async () => {
        await api(`/api/availability/${p.id}/agree`, {
          method: "POST",
          body: JSON.stringify({ member: me() })
        });
        await load();
      });
      row.append(agreeBtn);

      if (all3) {
        const lock = document.createElement("span");
        lock.className = "calLock";
        lock.textContent = "all three ✓";
        row.append(lock);
      }

      if (p.authorId === me()) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "calDelete";
        del.textContent = "✕";
        del.title = "Remove this proposal";
        del.addEventListener("click", async () => {
          await api(`/api/availability/${p.id}`, { method: "DELETE" });
          await load();
        });
        row.append(del);
      }
      slotsWrap.append(row);
    }
    if (!proposals.length) {
      const empty = document.createElement("div");
      empty.className = "calEmpty muted";
      empty.textContent = "No times proposed yet.";
      slotsWrap.append(empty);
    }
    card.append(slotsWrap);

    if (me()) {
      const add = document.createElement("div");
      add.className = "calAdd";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "calTimeInput";
      input.placeholder = "Propose a time, e.g. 9PM CST";
      input.autocomplete = "off";
      const btn = document.createElement("button");
      btn.className = "calAddBtn";
      btn.textContent = "Propose";
      const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        await api("/api/availability", {
          method: "POST",
          body: JSON.stringify({ date, text, authorId: me() })
        });
        input.value = "";
        await load();
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      add.append(input, btn);
      card.append(add);
    }
    wrap.append(card);
  }

  const summary = $("#calendarSummary");
  if (summary) summary.textContent = `${lockedDays}/7 days have a time all three agreed on.`;
}

async function addCurrentIdea() {
  const input = $("#ideaInput");
  if (!input.value.trim()) return;
  await api("/api/ideas", { method: "POST", body: JSON.stringify({ text: input.value, actorId: me() }) });
  input.value = "";
  await load();
}

async function copyPrompt(button, text) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied ✓";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

const TRIAGE_PROMPT = `In the ProductivityTime app at ~/Documents/ProductivityTime, triage my new ideas.
1. Run: node bin/track.js sync
2. Run: node bin/track.js ideas --status new
3. For each new idea run: node bin/track.js idea triage <id> --json '{"summary":"clarified one-liner","kind":"idea|reminder|think-about|task","nextSteps":["..."],"thoughts":"optional","suggestedGoal":{"title":"...","areas":["Product"],"assignees":["Sami"]}}'
   (omit suggestedGoal if it should not become a goal)
4. Run: node bin/track.js sync`;

const FOCUS_PROMPT = `In the ProductivityTime app at ~/Documents/ProductivityTime, write today's daily focus.
1. Run: node bin/track.js sync
2. Read goals: node bin/track.js list   and ideas: node bin/track.js ideas
3. Call: node bin/track.js focus add --json '{"audience":"team","headline":"short headline","items":[{"type":"focus","text":"what to focus on"},{"type":"stale","text":"what has gone stale (name the goal)"},{"type":"think","text":"a question worth thinking about"}]}'
4. Run: node bin/track.js sync`;

document.addEventListener("DOMContentLoaded", () => {
  fields.date.value = today();
  if (!fields.timezone.value) fields.timezone.value = localTimeZone();
  fillDatalist("#outputTypeList", OUTPUT_TYPE_LIST);

  $("#addButton").addEventListener("click", addCurrentGoal);
  $("#addIdeaButton").addEventListener("click", addCurrentIdea);
  $("#addOutputButton").addEventListener("click", addCurrentOutput);
  $("#addQuestionButton").addEventListener("click", addCurrentQuestion);
  $("#copyTriagePrompt").addEventListener("click", (event) => copyPrompt(event.currentTarget, TRIAGE_PROMPT));
  $("#copyFocusPrompt").addEventListener("click", (event) => copyPrompt(event.currentTarget, FOCUS_PROMPT));
  $("#copyAccountabilityPrompt").addEventListener("click", (event) =>
    copyPrompt(event.currentTarget, buildAccountabilityPrompt())
  );
  $("#currentUserSelect").addEventListener("change", async (event) => {
    const who = event.currentTarget.value;
    try {
      if (who) localStorage.setItem("pt_user", who);
      else localStorage.removeItem("pt_user");
    } catch (error) { /* private mode */ }
    await load();
  });
  $("#refreshButton").addEventListener("click", load);
  $("#loginButton").addEventListener("click", doLogin);
  $("#loginToken").addEventListener("keydown", (event) => {
    if (event.key === "Enter") doLogin();
  });
  $("#lockButton").addEventListener("click", logout);
  // Sync button removed — auto-sync handles push/pull automatically (the "● live"
  // indicator shows it's on). Refresh stays as a manual force-reload.

  document.querySelectorAll(".appTab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.page = tab.dataset.page;
      render();
      window.scrollTo({ top: 0 });
    });
  });

  $("#teamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addMetadataItem("team", $("#teamNameInput").value);
    $("#teamNameInput").value = "";
  });

  $("#areaForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addMetadataItem("areas", $("#areaNameInput").value);
    $("#areaNameInput").value = "";
  });

  $("#tokenForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const t = $("#tokenInput").value.trim();
    if (t) window.PTStore.setToken(t);
    $("#tokenInput").value = "";
    const status = $("#tokenStatus");
    try {
      await window.PTStore.verifyAccount();
      await load();
      if (status) status.textContent = `Connected as @${window.PTStore.login()} — saving to GitHub. ✓`;
    } catch (error) {
      if (status) status.textContent = error.message || "Could not connect to GitHub.";
    }
  });

  $("#repoForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/repo", {
      method: "POST",
      body: JSON.stringify({
        repoUrl: $("#repoUrlInput").value,
        branch: $("#branchInput").value || "main",
        userName: $("#gitNameInput").value,
        userEmail: $("#gitEmailInput").value
      })
    });
    await load();
  });

  $("#autoSyncToggle").addEventListener("change", async (event) => {
    await api("/api/autosync", {
      method: "POST",
      body: JSON.stringify({ enabled: event.currentTarget.checked })
    });
    await load();
  });

  $("#viewModal").addEventListener("click", (event) => {
    if (event.target.hasAttribute("data-close")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#viewModal").hidden) closeModal();
  });

  document.addEventListener("click", (event) => {
    document.querySelectorAll(".multiSelectMenu").forEach((menu) => {
      if (!menu.parentElement.contains(event.target)) menu.hidden = true;
    });
  });

  // First run on a device (no identity or no GitHub token): show the login
  // (password + token) before trying to load — don't error on a missing token.
  if (!me() || !window.PTStore.hasToken()) {
    $("#loginOverlay").hidden = false;
    $("#loginName").focus();
    setInterval(pollData, 8000);
  } else {
    load()
      .then(() => setInterval(pollData, 8000))
      .catch((error) => {
        $("#loginOverlay").hidden = false;
        $("#loginError").textContent = error.message || "Could not connect to GitHub.";
      });
  }
});
