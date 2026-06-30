// PTStore — serverless data layer. The app talks to GitHub directly instead of a
// local Node server: it reads data/goals.json from the private repo and writes it
// back via the GitHub Contents API, using each founder's personal token.
//
// Concurrency: every write does load-latest -> apply this one change -> save with
// the file's sha. If someone else saved in between (HTTP 409/422), it reloads the
// latest and RE-APPLIES the same change, so two people editing at once never lose
// data and deletes still stick. No merge driver needed.
//
// Works in the browser (window.PTStore + window.api) and in Node (module.exports)
// so the pure data logic can be unit-tested without GitHub.
(function () {
  "use strict";

  // ---- config (the private data repo) ----------------------------------------
  const cfg = {
    owner: "Rali7713",
    repo: "ProductivityTime",
    file: "data/goals.json",
    branch: "main",
    api: "https://api.github.com"
  };

  // Only these GitHub accounts (the three founders) may use the app. This is an
  // explicit front-door check; the real, unbypassable gate is still GitHub's
  // private-repo permissions (a non-collaborator's token can't touch the data).
  const ALLOWED_LOGINS = ["ahnaf-raihan", "rali7713", "samirasheedpc"];

  // ---- pure helpers (ported from lib.js) -------------------------------------
  const FOUNDERS = ["Sami", "Reyan", "Ahnaf"];
  const OUTPUT_STATUSES = ["none", "not_started", "in_progress", "shipped"];

  function nowIso() { return new Date().toISOString(); }
  function todayLocal() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  }
  function id(prefix) {
    return `${prefix || "goal"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function parseList(value) {
    if (Array.isArray(value)) return value.map((i) => String(i).trim()).filter(Boolean);
    if (!value) return [];
    return String(value).split(",").map((i) => i.trim()).filter(Boolean);
  }
  function snippet(text, max) {
    const v = String(text || "").replace(/\s+/g, " ").trim();
    max = max || 60;
    return v.length > max ? `${v.slice(0, max)}…` : v;
  }
  function goalRequiresAllFounders(goal) {
    const a = (goal && goal.assignees) || [];
    return FOUNDERS.every((f) => a.includes(f));
  }
  function foundersPendingSignoff(goal) {
    const it = (goal && goal.interactions) || {};
    return FOUNDERS.filter((f) => !(it[f] && it[f].status === "done"));
  }

  const INTERACTION_VERBS = {
    viewed: "acknowledged", reacted: "reacted to", question: "asked a question on",
    blocked: "marked blocked", will_do: "will take", done: "marked done"
  };

  function emptyData() {
    return { team: [], areas: [], goals: [], ideas: [], focus: [], memberTimezones: {}, dailyOutputs: [], activity: [], questions: [], availability: [] };
  }
  function ensureShape(d) {
    d = d || {};
    d.team = d.team || []; d.areas = d.areas || []; d.goals = d.goals || []; d.ideas = d.ideas || [];
    d.focus = d.focus || []; d.memberTimezones = d.memberTimezones || {}; d.dailyOutputs = d.dailyOutputs || [];
    d.activity = d.activity || []; d.questions = d.questions || []; d.availability = d.availability || [];
    return d;
  }

  // ---- in-memory data (the working copy) -------------------------------------
  let DATA = emptyData();
  let SHA = null;
  function readData() { return DATA; }
  function writeData(d) { DATA = ensureShape(d); }
  // test hook
  function _reset(d) { DATA = ensureShape(d || emptyData()); SHA = null; }

  function pushActivity(data, entry) {
    data.activity = data.activity || [];
    data.activity.unshift({
      id: id("act"), type: String(entry.type || "system"), actorId: String(entry.actorId || "").trim(),
      targetType: entry.targetType || "system", targetId: entry.targetId || null,
      message: String(entry.message || "").trim(), createdAt: nowIso()
    });
    data.activity = data.activity.slice(0, 200);
  }

  // ---- normalizers + mutations (ported faithfully from lib.js) ---------------
  function ensureMetadata(data, goal) {
    for (const p of goal.assignees) if (!data.team.includes(p)) data.team.push(p);
    for (const a of parseList(goal.areas != null ? goal.areas : goal.area)) if (a && !data.areas.includes(a)) data.areas.push(a);
  }
  function normalizeGoal(input, existing) {
    existing = existing || {};
    const date = input.date || existing.date || todayLocal();
    const areas = parseList(input.areas != null ? input.areas : input.area != null ? input.area : existing.areas != null ? existing.areas : existing.area != null ? existing.area : ["Product"]);
    return {
      id: existing.id || input.id || id("goal"),
      title: String(input.title || existing.title || "").trim(),
      date, time: String(input.time != null ? input.time : existing.time != null ? existing.time : "").trim(),
      timeZone: String(input.timeZone != null ? input.timeZone : existing.timeZone != null ? existing.timeZone : "").trim(),
      area: areas[0] || "Product", areas,
      assignees: parseList(input.assignees != null ? input.assignees : existing.assignees != null ? existing.assignees : []),
      notes: String(input.notes != null ? input.notes : existing.notes != null ? existing.notes : "").trim(),
      completed: Boolean(input.completed != null ? input.completed : existing.completed != null ? existing.completed : false),
      completedAt: input.completedAt != null ? input.completedAt : existing.completedAt != null ? existing.completedAt : null,
      interactions: input.interactions != null ? input.interactions : existing.interactions != null ? existing.interactions : {},
      replies: input.replies != null ? input.replies : existing.replies != null ? existing.replies : [],
      createdAt: existing.createdAt || input.createdAt || nowIso(),
      updatedAt: nowIso()
    };
  }
  function addGoal(input) {
    const data = readData(); const goal = normalizeGoal(input);
    if (!goal.title) throw new Error("Goal title is required.");
    data.goals.unshift(goal); ensureMetadata(data, goal);
    pushActivity(data, { type: "goal_created", actorId: input.actorId, targetType: "goal", targetId: goal.id, message: `${input.actorId || "Someone"} created goal: ${snippet(goal.title)}` });
    writeData(data); return goal;
  }
  function updateGoal(goalId, patch) {
    const data = readData(); const i = data.goals.findIndex((g) => g.id === goalId);
    if (i === -1) throw new Error(`Goal not found: ${goalId}`);
    const next = normalizeGoal(patch, data.goals[i]);
    if (!next.title) throw new Error("Goal title is required.");
    data.goals[i] = next; ensureMetadata(data, next); writeData(data); return next;
  }
  function completeGoal(goalId, completed, actor) {
    completed = completed !== false;
    const data = readData(); const i = data.goals.findIndex((g) => g.id === goalId);
    if (i === -1) throw new Error(`Goal not found: ${goalId}`);
    const current = data.goals[i];
    if (completed && goalRequiresAllFounders(current)) {
      const pending = foundersPendingSignoff(current);
      if (pending.length) throw new Error(`All-founder task — still waiting on ${pending.join(", ")} to mark done before it can be completed.`);
    }
    const next = normalizeGoal({ completed, completedAt: completed ? nowIso() : null }, current);
    data.goals[i] = next;
    pushActivity(data, { type: completed ? "goal_completed" : "goal_reopened", actorId: actor, targetType: "goal", targetId: goalId, message: `${actor || "Someone"} ${completed ? "completed" : "reopened"} goal: ${snippet(next.title)}` });
    writeData(data); return next;
  }
  function removeGoal(goalId) {
    const data = readData(); const before = data.goals.length;
    data.goals = data.goals.filter((g) => g.id !== goalId);
    if (data.goals.length === before) throw new Error(`Goal not found: ${goalId}`);
    writeData(data);
  }
  function updateTeam(team) { const data = readData(); data.team = [...new Set(parseList(team))]; writeData(data); return data.team; }
  function renameTeamMember(from, to) {
    const data = readData(); const o = String(from || "").trim(); const n = String(to || "").trim();
    if (!o || !n) throw new Error("Both from and to names are required.");
    data.team = [...new Set(data.team.map((p) => (p === o ? n : p)))];
    data.goals = data.goals.map((g) => ({ ...g, assignees: g.assignees.map((p) => (p === o ? n : p)), updatedAt: g.assignees.includes(o) ? nowIso() : g.updatedAt }));
    if (data.memberTimezones && data.memberTimezones[o]) { data.memberTimezones[n] = data.memberTimezones[o]; delete data.memberTimezones[o]; }
    writeData(data); return data.team;
  }
  function setMemberTimezone(name, timeZone) {
    const data = readData(); const p = String(name || "").trim();
    if (!p) throw new Error("Member name is required.");
    data.memberTimezones = data.memberTimezones || {}; const z = String(timeZone || "").trim();
    if (z) data.memberTimezones[p] = z; else delete data.memberTimezones[p];
    writeData(data); return data.memberTimezones;
  }
  function updateAreas(areas) { const data = readData(); data.areas = [...new Set(parseList(areas))]; writeData(data); return data.areas; }
  function renameArea(from, to) {
    const data = readData(); const o = String(from || "").trim(); const n = String(to || "").trim();
    if (!o || !n) throw new Error("Both from and to areas are required.");
    data.areas = [...new Set(data.areas.map((a) => (a === o ? n : a)))];
    data.goals = data.goals.map((g) => {
      const cur = parseList(g.areas != null ? g.areas : g.area);
      if (!cur.includes(o)) return g;
      const nx = [...new Set(cur.map((a) => (a === o ? n : a)))];
      return { ...g, area: nx[0] || n, areas: nx, updatedAt: nowIso() };
    });
    writeData(data); return data.areas;
  }

  function normalizeIdea(input, existing) {
    existing = existing || {};
    return {
      id: existing.id || input.id || id("idea"),
      text: String(input.text != null ? input.text : existing.text != null ? existing.text : "").trim(),
      author: String(input.author != null ? input.author : existing.author != null ? existing.author : "").trim(),
      status: input.status || existing.status || "new",
      triage: input.triage !== undefined ? input.triage : existing.triage != null ? existing.triage : null,
      promotedGoalId: input.promotedGoalId != null ? input.promotedGoalId : existing.promotedGoalId != null ? existing.promotedGoalId : null,
      interactions: input.interactions != null ? input.interactions : existing.interactions != null ? existing.interactions : {},
      replies: input.replies != null ? input.replies : existing.replies != null ? existing.replies : [],
      createdAt: existing.createdAt || input.createdAt || nowIso(), updatedAt: nowIso()
    };
  }
  function normalizeTriage(triage) {
    const t = triage || {}; const rg = t.suggestedGoal || {}; const title = String(rg.title || "").trim();
    const suggestedGoal = title ? { title, areas: parseList(rg.areas != null ? rg.areas : rg.area != null ? rg.area : []), assignees: parseList(rg.assignees != null ? rg.assignees : []), date: rg.date || todayLocal() } : null;
    return { summary: String(t.summary || "").trim(), kind: String(t.kind || "idea").trim(), shouldBecomeGoal: Boolean(t.shouldBecomeGoal != null ? t.shouldBecomeGoal : Boolean(suggestedGoal)), suggestedGoal, nextSteps: parseList(t.nextSteps != null ? t.nextSteps : []), thoughts: String(t.thoughts || "").trim(), by: String(t.by || "claude").trim(), at: nowIso() };
  }
  function addIdea(input) {
    const data = readData(); const idea = normalizeIdea(input);
    if (!idea.text) throw new Error("Idea text is required.");
    data.ideas.unshift(idea);
    pushActivity(data, { type: "idea_added", actorId: input.actorId || idea.author, targetType: "idea", targetId: idea.id, message: `${input.actorId || idea.author || "Someone"} added idea: ${snippet(idea.text)}` });
    writeData(data); return idea;
  }
  function updateIdea(ideaId, patch) {
    const data = readData(); const i = data.ideas.findIndex((x) => x.id === ideaId);
    if (i === -1) throw new Error(`Idea not found: ${ideaId}`);
    const prev = data.ideas[i].status; const next = normalizeIdea(patch, data.ideas[i]); data.ideas[i] = next;
    if (next.status === "archived" && prev !== "archived") pushActivity(data, { type: "idea_archived", actorId: patch.actorId, targetType: "idea", targetId: ideaId, message: `${patch.actorId || "Someone"} archived idea: ${snippet(next.text)}` });
    writeData(data); return next;
  }
  function triageIdea(ideaId, triage) { return updateIdea(ideaId, { triage: normalizeTriage(triage), status: "triaged" }); }
  function promoteIdea(ideaId, overrides) {
    overrides = overrides || {};
    const data = readData(); const i = data.ideas.findIndex((x) => x.id === ideaId);
    if (i === -1) throw new Error(`Idea not found: ${ideaId}`);
    const idea = data.ideas[i]; const s = (idea.triage && idea.triage.suggestedGoal) || {};
    const goal = normalizeGoal({ title: overrides.title || s.title || idea.text, date: overrides.date || s.date, areas: overrides.areas != null ? overrides.areas : overrides.area != null ? overrides.area : s.areas, assignees: overrides.assignees != null ? overrides.assignees : s.assignees, notes: overrides.notes != null ? overrides.notes : (idea.triage && idea.triage.summary) || "" });
    if (!goal.title) throw new Error("Cannot promote an idea with no title.");
    data.goals.unshift(goal); ensureMetadata(data, goal);
    data.ideas[i] = normalizeIdea({ status: "promoted", promotedGoalId: goal.id }, idea);
    pushActivity(data, { type: "idea_promoted", actorId: overrides.actorId, targetType: "goal", targetId: goal.id, message: `${overrides.actorId || "Someone"} promoted an idea to goal: ${snippet(goal.title)}` });
    writeData(data); return { goal, idea: data.ideas[i] };
  }
  function removeIdea(ideaId) {
    const data = readData(); const b = data.ideas.length; data.ideas = data.ideas.filter((x) => x.id !== ideaId);
    if (data.ideas.length === b) throw new Error(`Idea not found: ${ideaId}`); writeData(data);
  }
  function normalizeFocus(input, existing) {
    existing = existing || {};
    const items = Array.isArray(input.items) ? input.items.map((it) => ({ type: String(it.type || "focus").trim(), text: String(it.text || "").trim(), goalId: it.goalId || null })).filter((it) => it.text) : existing.items || [];
    return { id: existing.id || input.id || id("focus"), date: input.date || existing.date || todayLocal(), audience: String(input.audience != null ? input.audience : existing.audience != null ? existing.audience : "team").trim() || "team", headline: String(input.headline != null ? input.headline : existing.headline != null ? existing.headline : "").trim(), items, by: String(input.by != null ? input.by : existing.by != null ? existing.by : "claude").trim(), createdAt: existing.createdAt || input.createdAt || nowIso(), updatedAt: nowIso() };
  }
  function addFocus(input) {
    const data = readData(); const focus = normalizeFocus(input);
    if (!focus.items.length && !focus.headline) throw new Error("Focus needs a headline or at least one item.");
    data.focus.unshift(focus); data.focus = data.focus.slice(0, 30); writeData(data); return focus;
  }

  function setInteraction(targetType, recordId, body) {
    body = body || {}; const data = readData();
    const list = targetType === "idea" ? data.ideas : data.goals;
    const i = list.findIndex((r) => r.id === recordId);
    if (i === -1) throw new Error(`${targetType === "idea" ? "Idea" : "Goal"} not found: ${recordId}`);
    const member = String(body.member || body.actor || "").trim();
    if (!member) throw new Error("Member is required for an interaction.");
    const status = String(body.status || "viewed").trim(); const note = String(body.note || "").trim();
    const record = list[i]; record.interactions = record.interactions || {};
    record.interactions[member] = { status, note: note || undefined, updatedAt: nowIso() };
    pushActivity(data, { type: "interaction", actorId: member, targetType, targetId: recordId, message: `${member} ${INTERACTION_VERBS[status] || status} ${targetType === "idea" ? "idea" : "goal"}: ${snippet(record.title || record.text)}` });
    writeData(data); return record;
  }
  function recordOwner(record, targetType) {
    if (targetType === "output") return record.ownerId || "";
    if (targetType === "idea") return record.author || "";
    if (targetType === "question") return record.authorId || "";
    return (record.assignees && record.assignees[0]) || "";
  }
  function replyList(data, targetType) {
    if (targetType === "idea") return data.ideas;
    if (targetType === "output") return data.dailyOutputs;
    if (targetType === "question") return data.questions;
    return data.goals;
  }
  function addReply(targetType, recordId, body) {
    body = body || {}; const data = readData(); const list = replyList(data, targetType);
    const i = list.findIndex((r) => r.id === recordId);
    if (i === -1) throw new Error(`${targetType} not found: ${recordId}`);
    const author = String(body.author || body.actor || "").trim(); const text = String(body.text || "").trim();
    if (!author) throw new Error("Reply author is required.");
    if (!text) throw new Error("Reply text is required.");
    const record = list[i]; record.replies = record.replies || [];
    const to = recordOwner(record, targetType);
    const reply = { id: id("rep"), author, to, text, createdAt: nowIso() };
    if (targetType === "question") reply.agreeVotes = {};
    record.replies.push(reply);
    pushActivity(data, { type: "reply", actorId: author, targetType, targetId: recordId, message: `${author} replied${to ? ` to ${to}` : ""}: ${snippet(text)}` });
    writeData(data); return record;
  }

  function normalizeQuestion(input, existing) {
    existing = existing || {};
    return { id: existing.id || input.id || id("q"), topic: String(input.topic != null ? input.topic : existing.topic != null ? existing.topic : "").trim(), text: String(input.text != null ? input.text : input.question != null ? input.question : existing.text != null ? existing.text : "").trim(), authorId: String(input.authorId != null ? input.authorId : input.author != null ? input.author : existing.authorId != null ? existing.authorId : "").trim(), replies: input.replies != null ? input.replies : existing.replies != null ? existing.replies : [], createdAt: existing.createdAt || input.createdAt || nowIso(), updatedAt: nowIso() };
  }
  function addQuestion(input) {
    input = input || {}; const data = readData(); const q = normalizeQuestion(input);
    if (!q.text) throw new Error("Question text is required.");
    data.questions.unshift(q);
    pushActivity(data, { type: "question_asked", actorId: q.authorId, targetType: "question", targetId: q.id, message: `${q.authorId || "Someone"} asked${q.topic ? ` [${q.topic}]` : ""}: ${snippet(q.text)}` });
    writeData(data); return q;
  }
  function setReplyAgreement(questionId, body) {
    body = body || {}; const data = readData(); const q = data.questions.find((x) => x.id === questionId);
    if (!q) throw new Error(`Question not found: ${questionId}`);
    const replyId = String(body.replyId || "").trim(); const reply = (q.replies || []).find((r) => r.id === replyId);
    if (!reply) throw new Error(`Reply not found: ${replyId}`);
    const member = String(body.member || body.actor || "").trim();
    if (!member) throw new Error("Member is required to agree.");
    reply.agreeVotes = reply.agreeVotes && typeof reply.agreeVotes === "object" ? reply.agreeVotes : {};
    const had = Boolean(reply.agreeVotes[member] && reply.agreeVotes[member].agree);
    const agree = body.agree === undefined ? !had : Boolean(body.agree);
    reply.agreeVotes[member] = { agree, updatedAt: nowIso() };
    pushActivity(data, { type: "agree", actorId: member, targetType: "question", targetId: questionId, message: `${member} ${agree ? "agreed with" : "withdrew agreement with"} ${reply.author}: ${snippet(reply.text)}` });
    writeData(data); return q;
  }
  function removeQuestion(questionId) {
    const data = readData(); const b = data.questions.length; data.questions = data.questions.filter((x) => x.id !== questionId);
    if (data.questions.length === b) throw new Error(`Question not found: ${questionId}`); writeData(data);
  }

  function normalizeAvailability(input, existing) {
    existing = existing || {};
    return { id: existing.id || input.id || id("avail"), date: String(input.date != null ? input.date : existing.date != null ? existing.date : "").trim(), text: String(input.text != null ? input.text : input.time != null ? input.time : existing.text != null ? existing.text : "").trim(), authorId: String(input.authorId != null ? input.authorId : input.member != null ? input.member : input.actor != null ? input.actor : existing.authorId != null ? existing.authorId : "").trim(), agreeVotes: input.agreeVotes != null ? input.agreeVotes : existing.agreeVotes != null ? existing.agreeVotes : {}, createdAt: existing.createdAt || input.createdAt || nowIso(), updatedAt: nowIso() };
  }
  function addAvailability(input) {
    input = input || {}; const data = readData(); const slot = normalizeAvailability(input);
    if (!slot.date) throw new Error("Availability date is required.");
    if (!slot.text) throw new Error("A proposed time is required.");
    if (!slot.authorId) throw new Error("Availability author is required.");
    slot.agreeVotes[slot.authorId] = { agree: true, updatedAt: nowIso() };
    data.availability.unshift(slot);
    pushActivity(data, { type: "availability_proposed", actorId: slot.authorId, targetType: "availability", targetId: slot.id, message: `${slot.authorId} proposed ${slot.date}: ${snippet(slot.text)}` });
    writeData(data); return slot;
  }
  function setAvailabilityAgreement(slotId, body) {
    body = body || {}; const data = readData(); const slot = data.availability.find((a) => a.id === slotId);
    if (!slot) throw new Error(`Availability not found: ${slotId}`);
    const member = String(body.member || body.actor || "").trim();
    if (!member) throw new Error("Member is required to agree.");
    slot.agreeVotes = slot.agreeVotes && typeof slot.agreeVotes === "object" ? slot.agreeVotes : {};
    const had = Boolean(slot.agreeVotes[member] && slot.agreeVotes[member].agree);
    const agree = body.agree === undefined ? !had : Boolean(body.agree);
    slot.agreeVotes[member] = { agree, updatedAt: nowIso() };
    pushActivity(data, { type: "agree", actorId: member, targetType: "availability", targetId: slotId, message: `${member} ${agree ? "agreed to" : "withdrew from"} ${slot.date}: ${snippet(slot.text)}` });
    writeData(data); return slot;
  }
  function removeAvailability(slotId) {
    const data = readData(); const b = data.availability.length; data.availability = data.availability.filter((a) => a.id !== slotId);
    if (data.availability.length === b) throw new Error(`Availability not found: ${slotId}`); writeData(data);
  }

  function normalizeOutput(input, existing) {
    existing = existing || {};
    const status = OUTPUT_STATUSES.includes(input.status) ? input.status : existing.status || "none";
    return { id: existing.id || input.id || id("out"), ownerId: String(input.ownerId != null ? input.ownerId : existing.ownerId != null ? existing.ownerId : "").trim(), type: String(input.type != null ? input.type : existing.type != null ? existing.type : "").trim(), description: String(input.description != null ? input.description : existing.description != null ? existing.description : "").trim(), status, notes: String(input.notes != null ? input.notes : existing.notes != null ? existing.notes : "").trim(), replies: input.replies != null ? input.replies : existing.replies != null ? existing.replies : [], createdAt: existing.createdAt || input.createdAt || nowIso(), updatedAt: nowIso() };
  }
  function addDailyOutput(input) {
    const data = readData(); const o = normalizeOutput(input);
    if (!o.ownerId) throw new Error("Output owner is required.");
    if (!o.description) throw new Error("Output description is required.");
    data.dailyOutputs.unshift(o);
    pushActivity(data, { type: "output_posted", actorId: o.ownerId, targetType: "output", targetId: o.id, message: `${o.ownerId} posted output${o.type ? ` (${o.type})` : ""}: ${snippet(o.description)}` });
    writeData(data); return o;
  }
  function updateDailyOutput(outputId, patch) {
    patch = patch || {}; const data = readData(); const i = data.dailyOutputs.findIndex((o) => o.id === outputId);
    if (i === -1) throw new Error(`Output not found: ${outputId}`);
    const prev = data.dailyOutputs[i]; const next = normalizeOutput(patch, prev); data.dailyOutputs[i] = next;
    if (patch.status && patch.status !== prev.status) pushActivity(data, { type: "status_changed", actorId: String(patch.actor || next.ownerId || "").trim(), targetType: "output", targetId: next.id, message: `${next.ownerId}'s output is now ${next.status.replace("_", " ")}: ${snippet(next.description)}` });
    writeData(data); return next;
  }
  function removeDailyOutput(outputId) {
    const data = readData(); const b = data.dailyOutputs.length; data.dailyOutputs = data.dailyOutputs.filter((o) => o.id !== outputId);
    if (data.dailyOutputs.length === b) throw new Error(`Output not found: ${outputId}`); writeData(data);
  }

  // ---- request router: maps the old /api/* calls to the ported mutations -----
  // Returns { result, message }; throws on validation errors (the old 400s).
  function applyWrite(parts, method, body) {
    const r = parts[0], id1 = parts[1], action = parts[2];
    if (r === "goals") {
      if (method === "POST" && !id1) return { result: addGoal(body), message: `Add goal: ${snippet(body.title || "")}` };
      if (method === "PATCH" && id1) return { result: updateGoal(id1, body), message: "Edit goal" };
      if (method === "POST" && action === "complete") return { result: completeGoal(id1, true, body.actor), message: "Complete goal" };
      if (method === "POST" && action === "reopen") return { result: completeGoal(id1, false, body.actor), message: "Reopen goal" };
      if (method === "POST" && action === "interact") return { result: setInteraction("goal", id1, body), message: "Goal interaction" };
      if (method === "POST" && action === "reply") return { result: addReply("goal", id1, body), message: "Reply on goal" };
      if (method === "DELETE" && id1) { removeGoal(id1); return { result: { ok: true }, message: "Delete goal" }; }
    }
    if (r === "ideas") {
      if (method === "POST" && !id1) return { result: addIdea(body), message: "Add idea" };
      if (method === "POST" && action === "triage") return { result: triageIdea(id1, body.triage != null ? body.triage : body), message: "Triage idea" };
      if (method === "POST" && action === "promote") return { result: promoteIdea(id1, body), message: "Promote idea" };
      if (method === "PATCH" && id1) return { result: updateIdea(id1, body), message: "Edit idea" };
      if (method === "POST" && action === "interact") return { result: setInteraction("idea", id1, body), message: "Idea interaction" };
      if (method === "POST" && action === "reply") return { result: addReply("idea", id1, body), message: "Reply on idea" };
      if (method === "DELETE" && id1) { removeIdea(id1); return { result: { ok: true }, message: "Delete idea" }; }
    }
    if (r === "outputs") {
      if (method === "POST" && !id1) return { result: addDailyOutput(body), message: "Post output" };
      if (method === "POST" && action === "reply") return { result: addReply("output", id1, body), message: "Reply on output" };
      if (method === "PATCH" && id1) return { result: updateDailyOutput(id1, body), message: "Edit output" };
      if (method === "DELETE" && id1) { removeDailyOutput(id1); return { result: { ok: true }, message: "Delete output" }; }
    }
    if (r === "questions") {
      if (method === "POST" && !id1) return { result: addQuestion(body), message: "Ask question" };
      if (method === "POST" && action === "reply") return { result: addReply("question", id1, body), message: "Reply on question" };
      if (method === "POST" && action === "agree") return { result: setReplyAgreement(id1, body), message: "Agree on question" };
      if (method === "DELETE" && id1) { removeQuestion(id1); return { result: { ok: true }, message: "Delete question" }; }
    }
    if (r === "availability") {
      if (method === "POST" && !id1) return { result: addAvailability(body), message: "Propose time" };
      if (method === "POST" && action === "agree") return { result: setAvailabilityAgreement(id1, body), message: "Agree on time" };
      if (method === "DELETE" && id1) { removeAvailability(id1); return { result: { ok: true }, message: "Delete time" }; }
    }
    if (r === "team") {
      if (method === "PATCH") return { result: { team: updateTeam(body.team) }, message: "Edit team" };
      if (method === "POST" && id1 === "rename") return { result: { team: renameTeamMember(body.from, body.to) }, message: "Rename member" };
      if (method === "POST" && id1 === "timezone") return { result: { memberTimezones: setMemberTimezone(body.name, body.timeZone) }, message: "Set timezone" };
    }
    if (r === "areas") {
      if (method === "PATCH") return { result: { areas: updateAreas(body.areas) }, message: "Edit areas" };
      if (method === "POST" && id1 === "rename") return { result: { areas: renameArea(body.from, body.to) }, message: "Rename area" };
    }
    if (r === "focus" && method === "POST") return { result: addFocus(body), message: "Add focus" };
    throw new Error(`Unknown route ${method} /${parts.join("/")}`);
  }

  // browser-only sections are defined below the UMD boundary
  const pure = {
    FOUNDERS, OUTPUT_STATUSES, emptyData, ensureShape, readData, writeData, _reset,
    nowIso, todayLocal, id, parseList, snippet, goalRequiresAllFounders, foundersPendingSignoff,
    addGoal, updateGoal, completeGoal, removeGoal, updateTeam, renameTeamMember, setMemberTimezone,
    updateAreas, renameArea, addIdea, updateIdea, triageIdea, promoteIdea, removeIdea, addFocus,
    setInteraction, addReply, addQuestion, setReplyAgreement, removeQuestion,
    addAvailability, setAvailabilityAgreement, removeAvailability,
    addDailyOutput, updateDailyOutput, removeDailyOutput, normalizeTriage, applyWrite,
    getSha: () => SHA, setSha: (s) => { SHA = s; }
  };

  // ---- Node (tests) ----------------------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = pure;
    return;
  }

  // ---- Browser: GitHub I/O + window.api --------------------------------------
  function token() { try { return localStorage.getItem("pt_gh_token") || ""; } catch (e) { return ""; } }
  let verifiedLogin = null;
  function setToken(t) { try { localStorage.setItem("pt_gh_token", String(t || "").trim()); } catch (e) {} verifiedLogin = null; }
  // Confirm the token belongs to one of the three founders' GitHub accounts.
  async function verifyAccount() {
    if (verifiedLogin) return verifiedLogin;
    const res = await gh("GET", "/user");
    if (!res.ok) throw new Error(await ghError(res));
    const u = await res.json();
    const login = String(u.login || "");
    if (!ALLOWED_LOGINS.includes(login.toLowerCase())) {
      const e = new Error(`@${login} isn't authorized — only the three founders' GitHub accounts can use this app.`);
      e.unauthorized = true; throw e;
    }
    verifiedLogin = login;
    return login;
  }
  function repoConfig() {
    try {
      const o = localStorage.getItem("pt_gh_owner"); const r = localStorage.getItem("pt_gh_repo");
      if (o) cfg.owner = o; if (r) cfg.repo = r;
    } catch (e) {}
    return cfg;
  }
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(b64) { return decodeURIComponent(escape(atob(String(b64 || "").replace(/\s+/g, "")))); }

  async function gh(method, url, jsonBody) {
    if (!token()) { const e = new Error("No GitHub token yet — paste one in Settings."); e.noToken = true; throw e; }
    return fetch(cfg.api + url, {
      method,
      headers: { Authorization: "Bearer " + token(), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined
    });
  }
  async function ghError(res) {
    if (res.status === 401) return "GitHub token missing or invalid — re-paste it in Settings.";
    if (res.status === 404) return "Can't find the data file/repo (check the token has access).";
    let m = "GitHub error " + res.status;
    try { const j = await res.json(); if (j.message) m += ": " + j.message; } catch (e) {}
    return m;
  }
  async function ghGet() {
    repoConfig();
    const res = await gh("GET", `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.file}?ref=${cfg.branch}&t=${Date.now()}`);
    if (res.status === 404) return { data: emptyData(), sha: null };
    if (!res.ok) throw new Error(await ghError(res));
    const j = await res.json();
    let data; try { data = JSON.parse(b64decode(j.content)); } catch (e) { data = emptyData(); }
    return { data: ensureShape(data), sha: j.sha };
  }
  async function ghPut(data, sha, message) {
    repoConfig();
    const res = await gh("PUT", `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.file}`, {
      message: message || "Update", content: b64encode(JSON.stringify(data, null, 2) + "\n"), sha: sha || undefined, branch: cfg.branch
    });
    if (res.status === 409 || res.status === 422) { const e = new Error("conflict"); e.conflict = true; throw e; }
    if (!res.ok) throw new Error(await ghError(res));
    const j = await res.json();
    return j.content.sha;
  }
  async function loadLatest() { const { data, sha } = await ghGet(); DATA = data; SHA = sha; return DATA; }

  async function request(path, options) {
    options = options || {};
    const method = (options.method || "GET").toUpperCase();
    let body = {}; if (options.body) { try { body = JSON.parse(options.body); } catch (e) { body = {}; } }
    const parts = String(path).replace(/^\//, "").split("?")[0].split("/").filter(Boolean);
    if (parts[0] === "api") parts.shift();
    const r = parts[0];

    // local-only endpoints (no GitHub)
    if (r === "me") return { ok: true };
    if (r === "repo") return { repoUrl: cfg.owner + "/" + cfg.repo, branch: cfg.branch, initialized: true, remote: cfg.owner + "/" + cfg.repo, currentBranch: cfg.branch, autoSync: true, currentUser: "" };
    if (r === "autosync") return { autoSync: true };
    if (r === "sync") { await loadLatest(); return { ok: true }; }

    if (method === "GET") {
      await loadLatest();
      if (r === "goals") return DATA;
      if (r === "ideas") return DATA.ideas;
      if (r === "outputs") return DATA.dailyOutputs;
      if (r === "questions") return DATA.questions;
      if (r === "availability") return DATA.availability;
      if (r === "activity") return DATA.activity;
      if (r === "focus") return DATA.focus;
      throw new Error("Unknown GET " + path);
    }

    // write: load-latest -> apply this change -> save; re-apply on conflict
    for (let attempt = 0; attempt < 5; attempt++) {
      await loadLatest();
      const { result, message } = applyWrite(parts, method, body); // mutates DATA; may throw validation
      try { SHA = await ghPut(DATA, SHA, message); return result; }
      catch (e) { if (!e.conflict) throw e; /* someone else saved; loop and re-apply */ }
    }
    throw new Error("Too many people saved at once — try that again.");
  }

  window.PTStore = { request, token, setToken, hasToken: () => !!token(), verifyAccount, login: () => verifiedLogin, config: cfg, loadLatest };
  // Route the app's existing api() through the store.
  window.api = function (path, options) { return window.PTStore.request(path, options); };
})();
