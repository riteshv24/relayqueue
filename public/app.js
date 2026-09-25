"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  key: sessionStorage.getItem("relayqueue-key") || "",
  connected: false,
  page: 1,
  total: 0,
  pageSize: 12,
  selectedId: null,
  timer: null,
  refreshing: false,
};
const statusNames = {
  pending: "Pending",
  processing: "Processing",
  succeeded: "Succeeded",
  dead: "Dead letter",
};
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}
function showNotice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "notice error" : "notice";
  $("notice").hidden = !message;
}
function badge(status) {
  return node(
    "span",
    "badge " + (Object.hasOwn(statusNames, status) ? status : ""),
    statusNames[status] || status,
  );
}
function randomKey() {
  return "console-" + crypto.randomUUID();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: "Bearer " + state.key,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    if (response.status === 401) setConnected(false);
    const detail =
      typeof data.error === "string"
        ? data.error
        : data.error?.message || data.message;
    throw new Error(detail || "Request failed (HTTP " + response.status + ").");
  }
  return data;
}

function setConnected(connected) {
  state.connected = connected;
  $("connect-panel").hidden = connected;
  $("connection-button").textContent = connected ? "Disconnect" : "Connect API";
  $("sidebar-status").textContent = connected
    ? "API connected"
    : "Not connected";
  $("sidebar-dot").classList.toggle("connected", connected);
  $("live-label").classList.toggle("connected", connected);
  $("live-label").lastChild.textContent = connected
    ? "Updates every 5s"
    : "Live updates paused";
  for (const id of ["new-event-button", "refresh-button", "status-filter"])
    $(id).disabled = !connected;
  if (state.timer) clearInterval(state.timer);
  state.timer = connected
    ? setInterval(() => {
        if (!document.hidden) refresh(false);
      }, 5000)
    : null;
  updatePagination();
}

function updatePagination() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("page-label").textContent = "Page " + state.page + " of " + pages;
  $("previous-page").disabled = !state.connected || state.page <= 1;
  $("next-page").disabled = !state.connected || state.page >= pages;
}

function renderEvents(data) {
  state.total = data.total;
  $("event-count").textContent =
    data.total.toLocaleString() +
    (data.total === 1 ? " event" : " events") +
    ($("status-filter").value ? " matching filter" : " in this queue");
  const rows = $("event-rows");
  rows.replaceChildren();
  for (const event of data.events) {
    const row = node("tr");
    row.classList.toggle("selected", event.id === state.selectedId);
    const eventCell = node("td");
    const select = node("button", "event-select", event.type);
    select.type = "button";
    select.title = "Inspect event " + event.id;
    select.addEventListener("click", () => selectEvent(event.id));
    eventCell.append(
      select,
      node("span", "event-id", event.id.slice(0, 12) + "…"),
    );
    const statusCell = node("td");
    statusCell.append(badge(event.status));
    row.append(
      eventCell,
      statusCell,
      node("td", "", event.cycleAttempts + " / " + event.maxAttempts),
      node("td", "created-cell", formatDate(event.createdAt)),
    );
    rows.append(row);
  }
  $("events-empty").hidden = data.events.length > 0;
  if (!data.events.length) {
    $("events-empty").querySelector("h3").textContent = $("status-filter").value
      ? "No events with this status"
      : "Your queue is ready";
    $("events-empty").querySelector("p").textContent = $("status-filter").value
      ? "Choose a different status to explore your queue."
      : "Create your first event to see delivery and retry activity.";
  }
  updatePagination();
}

async function refresh(announce = false) {
  if (!state.connected || state.refreshing) return;
  state.refreshing = true;
  $("refresh-button").disabled = true;
  try {
    const params = new URLSearchParams({
      page: state.page,
      pageSize: state.pageSize,
    });
    if ($("status-filter").value)
      params.set("status", $("status-filter").value);
    const [stats, events] = await Promise.all([
      api("/api/stats"),
      api("/api/events?" + params),
    ]);
    for (const status of Object.keys(statusNames))
      $("stat-" + status).textContent = Number(
        stats[status] ?? 0,
      ).toLocaleString();
    renderEvents(events);
    if (state.selectedId) await loadDetail(state.selectedId);
    $("last-updated").textContent =
      "Last synced " +
      new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    if (announce) showNotice("Queue refreshed.");
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    state.refreshing = false;
    $("refresh-button").disabled = !state.connected;
  }
}

async function selectEvent(id) {
  state.selectedId = id;
  $("detail-empty").hidden = true;
  $("event-detail").hidden = false;
  $("event-detail").replaceChildren(
    node("p", "muted", "Loading event details…"),
  );
  try {
    await loadDetail(id);
    await refresh(false);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function loadDetail(id) {
  const data = await api("/api/events/" + encodeURIComponent(id));
  if (state.selectedId !== id) return;
  const event = data.event;
  const container = $("event-detail");
  container.replaceChildren();
  container.append(
    node("h3", "detail-title", event.type),
    badge(event.status),
    node("div", "detail-id", event.id),
  );
  const metadata = node("dl", "metadata");
  for (const [label, value] of [
    ["Created", formatDate(event.createdAt)],
    ["Updated", formatDate(event.updatedAt)],
    ["Cycle attempts", event.cycleAttempts + " / " + event.maxAttempts],
    ["Total attempts", event.totalAttempts],
    [
      "Next attempt",
      ["pending", "processing"].includes(event.status)
        ? formatDate(event.nextAttemptAt)
        : "—",
    ],
  ]) {
    const entry = node("div");
    entry.append(node("dt", "", label), node("dd", "", value));
    metadata.append(entry);
  }
  container.append(metadata);
  if (event.lastError)
    container.append(node("div", "error-box", event.lastError));
  container.append(
    node("h4", "detail-section-title", "Event payload"),
    node("pre", "payload", JSON.stringify(event.payload, null, 2)),
  );
  container.append(node("h4", "detail-section-title", "Delivery attempts"));
  if (!data.attempts.length)
    container.append(
      node(
        "p",
        "no-attempts",
        "No delivery attempts yet. The worker will pick up this event.",
      ),
    );
  const attempts = node("ol", "attempts");
  for (const attempt of data.attempts) {
    const success = ["success", "succeeded", "delivered"].includes(
      attempt.outcome,
    );
    const inFlight = attempt.outcome === "in_flight";
    const li = node(
      "li",
      "attempt " + (success ? "success" : inFlight ? "in-flight" : "failure"),
    );
    const heading = node("div", "attempt-heading");
    heading.append(
      node("span", "", "Attempt " + attempt.attemptNumber),
      node(
        "span",
        success ? "green" : inFlight ? "blue" : "red",
        attempt.statusCode
          ? "HTTP " + attempt.statusCode
          : inFlight
            ? "In flight"
            : attempt.outcome,
      ),
    );
    li.append(
      heading,
      node(
        "small",
        "",
        formatDate(attempt.startedAt) +
          (attempt.durationMs !== null && attempt.durationMs !== undefined
            ? " · " + attempt.durationMs + " ms"
            : ""),
      ),
    );
    if (attempt.error) li.append(node("p", "", attempt.error));
    attempts.append(li);
  }
  container.append(attempts);
  if (event.status === "dead") {
    const replay = node(
      "button",
      "button primary replay-button",
      "Replay event ↗",
    );
    replay.addEventListener("click", async () => {
      replay.disabled = true;
      replay.textContent = "Replaying…";
      try {
        await api("/api/events/" + encodeURIComponent(event.id) + "/replay", {
          method: "POST",
        });
        showNotice("Event queued for another delivery cycle.");
        await refresh(false);
      } catch (error) {
        showNotice(error.message, true);
        replay.disabled = false;
        replay.textContent = "Replay event ↗";
      }
    });
    container.append(replay);
  }
}

$("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.key = $("api-key").value.trim();
  if (!state.key) return;
  $("connect-submit").disabled = true;
  $("connect-submit").textContent = "Connecting…";
  try {
    await api("/api/stats");
    sessionStorage.setItem("relayqueue-key", state.key);
    setConnected(true);
    showNotice("Connected. Queue activity updates automatically.");
    await refresh(false);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    $("connect-submit").disabled = false;
    $("connect-submit").textContent = "Connect";
  }
});
$("connection-button").addEventListener("click", () => {
  if (state.connected) {
    setConnected(false);
    sessionStorage.removeItem("relayqueue-key");
    state.key = "";
    $("api-key").value = "";
    showNotice("Disconnected. Reconnect to resume live updates.");
  }
  $("connect-panel").hidden = false;
  $("api-key").focus();
});
$("refresh-button").addEventListener("click", () => refresh(true));
$("status-filter").addEventListener("change", () => {
  state.page = 1;
  refresh(false);
});
$("previous-page").addEventListener("click", () => {
  state.page--;
  refresh(false);
});
$("next-page").addEventListener("click", () => {
  state.page++;
  refresh(false);
});
$("new-event-button").addEventListener("click", () => {
  $("idempotency-key").value = randomKey();
  $("form-error").hidden = true;
  $("event-dialog").showModal();
});
$("close-dialog").addEventListener("click", () => $("event-dialog").close());
$("reset-demo").addEventListener("click", () => {
  $("event-type").value = "build.completed";
  $("max-attempts").value = "5";
  $("idempotency-key").value = randomKey();
  $("event-payload").value = JSON.stringify(
    { commit: "a1b2c3d", branch: "main", status: "passed" },
    null,
    2,
  );
});
$("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("form-error").hidden = true;
  try {
    let payload;
    try {
      payload = JSON.parse($("event-payload").value);
    } catch {
      throw new Error("Enter valid JSON in the payload field.");
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      throw new Error(
        'The payload must be a JSON object, for example {"status":"passed"}.',
      );
    $("publish-button").disabled = true;
    $("publish-button").textContent = "Publishing…";
    const data = await api("/api/events", {
      method: "POST",
      headers: { "Idempotency-Key": $("idempotency-key").value.trim() },
      body: JSON.stringify({
        type: $("event-type").value.trim(),
        payload,
        maxAttempts: Number($("max-attempts").value),
      }),
    });
    $("event-dialog").close();
    state.page = 1;
    $("status-filter").value = "";
    showNotice(
      data.replayed
        ? "Existing event returned for this idempotency key."
        : "Event accepted. Follow its delivery in the inspector.",
    );
    await selectEvent(data.event.id);
  } catch (error) {
    $("form-error").textContent = error.message;
    $("form-error").hidden = false;
  } finally {
    $("publish-button").disabled = false;
    $("publish-button").textContent = "Publish event ↗";
  }
});

if (state.key) {
  $("api-key").value = state.key;
  setConnected(true);
  refresh(false);
}
