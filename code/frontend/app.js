const state = {
  token: localStorage.getItem("studyRoomToken") || "",
  user: null,
  bootstrap: null,
  selectedRoom: null,
  selectedSeat: null,
  lastSeats: []
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function today() {
  return new Date().toISOString().slice(0, 10);
}

function roleLabel(role) {
  return {
    STUDENT: "学生",
    ADMIN: "普通管理员",
    SUPER_ADMIN: "超级管理员"
  }[role] || role;
}

function statusLabel(status) {
  return {
    PENDING_CHECKIN: "待签到",
    IN_USE: "使用中",
    TEMP_LEAVE: "暂离",
    CANCELLED: "已取消",
    EXPIRED: "已失效",
    COMPLETED: "已完成",
    FREE: "空闲",
    RESERVED: "已预约",
    MAINTENANCE: "维修",
    DISABLED: "禁用",
    CLOSED: "关闭"
  }[status] || status;
}

function showToast(message, type = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.style.background = type === "error" ? "#b91c1c" : type === "success" ? "#166534" : "#0f172a";
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 3000);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({ message: "响应解析失败" }));
  if (!response.ok || payload.code !== "OK") {
    throw new Error(payload.message || "请求失败");
  }
  return payload.data;
}

function setView(loggedIn) {
  $("#loginView").classList.toggle("hidden", loggedIn);
  $("#appView").classList.toggle("hidden", !loggedIn);
}

function currentQuery() {
  return {
    date: $("#dateInput").value,
    startTime: $("#startInput").value,
    endTime: $("#endInput").value,
    buildingId: $("#buildingSelect").value
  };
}

async function login(account, password) {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password })
  });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("studyRoomToken", state.token);
  await initApp();
}

async function initApp() {
  try {
    const data = await api("/api/bootstrap");
    state.bootstrap = data;
    state.user = data.user;
    $("#userName").textContent = data.user.name;
    $("#userRole").textContent = `${roleLabel(data.user.role)} · ${data.user.accountNo}`;
    $$(".admin-only").forEach(el => el.classList.toggle("hidden", !data.roles.admin));
    renderBuildingSelect();
    fillRuleForm();
    setView(true);
    await loadRooms();
    await loadBookings();
    await loadMessages();
    if (data.roles.admin) {
      await loadResources();
      await loadStats();
    }
  } catch (error) {
    localStorage.removeItem("studyRoomToken");
    state.token = "";
    state.user = null;
    setView(false);
  }
}

function renderBuildingSelect() {
  const select = $("#buildingSelect");
  select.innerHTML = `<option value="">全部楼宇</option>`;
  for (const building of state.bootstrap.buildings) {
    const option = document.createElement("option");
    option.value = building.id;
    option.textContent = building.name;
    select.appendChild(option);
  }
}

async function loadRooms() {
  const query = currentQuery();
  const params = new URLSearchParams(query);
  const rooms = await api(`/api/rooms?${params}`);
  $("#roomSummary").textContent = `${rooms.length} 间`;
  const list = $("#roomList");
  list.innerHTML = "";
  if (!rooms.length) {
    list.innerHTML = `<div class="room-card">没有符合条件的自习室</div>`;
    return;
  }
  rooms.forEach(room => {
    const card = document.createElement("article");
    card.className = `room-card ${state.selectedRoom?.id === room.id ? "active" : ""}`;
    card.innerHTML = `
      <h4>${room.name}</h4>
      <div class="room-meta">
        <span>${room.building?.name || ""} ${room.floorNo}</span>
        <span>容量 ${room.capacity}</span>
        <span>空闲 ${room.stats.freeSeats}</span>
        <span>使用中 ${room.stats.inUseSeats}</span>
      </div>
    `;
    card.addEventListener("click", async () => {
      state.selectedRoom = room;
      state.selectedSeat = null;
      await loadSeats(room.id);
      await loadRooms();
    });
    list.appendChild(card);
  });
  if (!state.selectedRoom && rooms[0]) {
    state.selectedRoom = rooms[0];
    await loadSeats(rooms[0].id);
    await loadRooms();
  }
}

async function loadSeats(roomId) {
  const query = currentQuery();
  const params = new URLSearchParams({
    date: query.date,
    startTime: query.startTime,
    endTime: query.endTime
  });
  const data = await api(`/api/rooms/${roomId}/seats?${params}`);
  state.lastSeats = data.seats;
  $("#seatMapTitle").textContent = data.room.name;
  renderSeats(data.seats);
}

function renderSeats(seats) {
  const map = $("#seatMap");
  map.classList.remove("empty");
  map.innerHTML = "";
  const maxX = Math.max(...seats.map(seat => seat.posX), 6);
  map.style.gridTemplateColumns = `repeat(${maxX}, minmax(64px, 1fr))`;
  seats
    .slice()
    .sort((a, b) => a.posY - b.posY || a.posX - b.posX)
    .forEach(seat => {
      const button = document.createElement("button");
      button.className = `seat ${seat.displayStatus} ${state.selectedSeat?.id === seat.id ? "selected" : ""}`;
      button.disabled = seat.displayStatus !== "FREE";
      button.innerHTML = `
        <strong>${seat.seatNo}</strong>
        <small>${statusLabel(seat.displayStatus)}${seat.hasPower ? " · 插座" : ""}</small>
      `;
      button.addEventListener("click", () => {
        state.selectedSeat = seat;
        renderSeats(state.lastSeats);
        $("#selectedSeatLabel").textContent = seat.seatNo;
        $("#bookingPreview").textContent = `${state.selectedRoom.name} · ${seat.seatNo} · ${$("#startInput").value}-${$("#endInput").value}`;
        $("#createBookingBtn").disabled = false;
      });
      map.appendChild(button);
    });
}

async function createBooking() {
  if (!state.selectedSeat) return;
  const query = currentQuery();
  await api("/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      seatId: state.selectedSeat.id,
      date: query.date,
      startTime: query.startTime,
      endTime: query.endTime
    })
  });
  showToast("预约成功，请按时签到", "success");
  state.selectedSeat = null;
  $("#createBookingBtn").disabled = true;
  await loadSeats(state.selectedRoom.id);
  await loadRooms();
  await loadBookings();
  await loadMessages();
}

async function loadBookings() {
  const bookings = await api("/api/bookings");
  const list = $("#bookingList");
  list.innerHTML = "";
  if (!bookings.length) {
    list.innerHTML = `<div class="booking-card"><div>暂无预约记录</div></div>`;
    return;
  }
  bookings.forEach(booking => {
    const card = document.createElement("article");
    card.className = "booking-card";
    const start = formatDateTime(booking.startAt);
    const end = formatDateTime(booking.endAt);
    card.innerHTML = `
      <div>
        <h4>${booking.room?.name || "-"} · ${booking.seat?.seatNo || "-"}</h4>
        <p class="muted">${start} - ${end}</p>
        <span class="status-tag">${statusLabel(booking.status)}</span>
      </div>
      <div class="booking-actions"></div>
    `;
    const actions = card.querySelector(".booking-actions");
    if (booking.status === "PENDING_CHECKIN") {
      actions.appendChild(actionButton("扫码签到", () => checkin(booking.id)));
      actions.appendChild(actionButton("取消", () => cancelBooking(booking.id)));
    }
    if (booking.status === "IN_USE") {
      actions.appendChild(actionButton("暂离", () => leaveBooking(booking.id)));
      actions.appendChild(actionButton("结束", () => finishBooking(booking.id)));
    }
    if (booking.status === "TEMP_LEAVE") {
      actions.appendChild(actionButton("结束", () => finishBooking(booking.id)));
    }
    list.appendChild(card);
  });
}

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function cancelBooking(id) {
  await api(`/api/bookings/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "用户主动取消" })
  });
  showToast("预约已取消", "success");
  await refreshAll();
}

async function checkin(id) {
  await api("/api/checkins", {
    method: "POST",
    body: JSON.stringify({ bookingId: id, qrToken: "demo-qr-token" })
  });
  showToast("签到成功", "success");
  await refreshAll();
}

async function leaveBooking(id) {
  await api(`/api/bookings/${id}/leave`, { method: "POST", body: JSON.stringify({}) });
  showToast("已暂离，记得及时返回", "success");
  await refreshAll();
}

async function finishBooking(id) {
  await api(`/api/bookings/${id}/finish`, { method: "POST", body: JSON.stringify({}) });
  showToast("已结束使用", "success");
  await refreshAll();
}

async function loadMessages() {
  const messages = await api("/api/notices");
  const list = $("#messageList");
  list.innerHTML = "";
  if (!messages.length) {
    list.innerHTML = `<div class="message-card">暂无消息</div>`;
    return;
  }
  messages.forEach(message => {
    const card = document.createElement("article");
    card.className = "message-card";
    card.innerHTML = `
      <h4>${message.title}</h4>
      <p>${message.content}</p>
      <p class="muted">${formatDateTime(message.createdAt)} · ${message.type}</p>
    `;
    list.appendChild(card);
  });
}

async function loadResources() {
  const data = await api("/api/admin/resources");
  const list = $("#adminSeatList");
  list.innerHTML = "";
  const roomsById = Object.fromEntries(data.rooms.map(room => [room.id, room]));
  data.seats.slice(0, 80).forEach(seat => {
    const row = document.createElement("div");
    row.className = "admin-seat-row";
    row.innerHTML = `
      <div>
        <strong>${roomsById[seat.roomId]?.name || "-"} · ${seat.seatNo}</strong>
        <p class="muted">坐标：${seat.posX}, ${seat.posY} · ${seat.hasPower ? "有插座" : "无插座"}</p>
      </div>
      <select>
        <option value="NORMAL">正常</option>
        <option value="MAINTENANCE">维修</option>
        <option value="DISABLED">禁用</option>
      </select>
      <button>保存</button>
    `;
    const select = row.querySelector("select");
    select.value = seat.status;
    row.querySelector("button").addEventListener("click", async () => {
      await api(`/api/admin/seats/${seat.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: select.value })
      });
      showToast("座位状态已保存", "success");
      await refreshAll();
    });
    list.appendChild(row);
  });
}

function fillRuleForm() {
  if (!state.bootstrap?.rule) return;
  const form = $("#ruleForm");
  Object.entries(state.bootstrap.rule).forEach(([key, value]) => {
    const input = form.elements[key];
    if (input) input.value = value;
  });
}

async function saveRules(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {};
  Array.from(form.elements).forEach(element => {
    if (element.name) body[element.name] = element.value;
  });
  const rule = await api("/api/admin/rules", {
    method: "PUT",
    body: JSON.stringify(body)
  });
  state.bootstrap.rule = rule;
  fillRuleForm();
  showToast("预约规则已保存", "success");
}

async function loadStats() {
  const data = await api("/api/admin/statistics");
  $("#statsCards").innerHTML = `
    ${statCard("总预约", data.totalBookings)}
    ${statCard("有效预约", data.activeBookings)}
    ${statCard("签到率", `${Math.round(data.checkinRate * 100)}%`)}
    ${statCard("违规率", `${Math.round(data.violationRate * 100)}%`)}
  `;
  $("#roomStats").innerHTML = data.byRoom
    .map(item => `
      <div class="room-stat-row">
        <strong>${item.roomName}</strong>
        <span>预约 ${item.bookings} · 有效 ${item.active}</span>
      </div>
    `)
    .join("");
}

function statCard(label, value) {
  return `<div class="stat-card"><span class="muted">${label}</span><strong>${value}</strong></div>`;
}

async function refreshAll() {
  if (state.selectedRoom) await loadSeats(state.selectedRoom.id);
  await loadRooms();
  await loadBookings();
  await loadMessages();
  if (state.bootstrap?.roles.admin) {
    await loadResources();
    await loadStats();
  }
}

function switchTab(name) {
  $$(".nav button").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  $$(".tab-panel").forEach(panel => panel.classList.add("hidden"));
  $(`#${name}Tab`).classList.remove("hidden");
  $("#pageTitle").textContent = {
    reserve: "座位预约",
    bookings: "我的预约",
    messages: "消息通知",
    admin: "后台管理"
  }[name];
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function bindEvents() {
  $("#dateInput").value = today();
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await login($("#accountInput").value.trim(), $("#passwordInput").value);
      showToast("登录成功", "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  $$(".demo-accounts button").forEach(button => {
    button.addEventListener("click", () => {
      $("#accountInput").value = button.dataset.account;
      $("#passwordInput").value = button.dataset.password;
    });
  });
  $("#logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {}
    localStorage.removeItem("studyRoomToken");
    state.token = "";
    state.user = null;
    setView(false);
  });
  $$(".nav button").forEach(button => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  $("#searchRoomsBtn").addEventListener("click", async () => {
    state.selectedRoom = null;
    state.selectedSeat = null;
    $("#createBookingBtn").disabled = true;
    await loadRooms();
  });
  $("#createBookingBtn").addEventListener("click", () => createBooking().catch(error => showToast(error.message, "error")));
  $("#refreshBookingsBtn").addEventListener("click", () => loadBookings().catch(error => showToast(error.message, "error")));
  $("#refreshMessagesBtn").addEventListener("click", () => loadMessages().catch(error => showToast(error.message, "error")));
  $("#refreshResourcesBtn").addEventListener("click", () => loadResources().catch(error => showToast(error.message, "error")));
  $("#refreshStatsBtn").addEventListener("click", () => loadStats().catch(error => showToast(error.message, "error")));
  $("#ruleForm").addEventListener("submit", event => saveRules(event).catch(error => showToast(error.message, "error")));
}

bindEvents();
if (state.token) {
  initApp();
} else {
  setView(false);
}
