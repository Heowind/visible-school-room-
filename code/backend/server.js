const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 3000);

const ACTIVE_BOOKING_STATUSES = new Set(["PENDING_CHECKIN", "IN_USE", "TEMP_LEAVE"]);
const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (process.argv.includes("--reset-data") && fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(seedData(), null, 2));
  }
}

function seedData() {
  const now = new Date().toISOString();
  const seats = [];
  const roomConfigs = [
    { roomId: 1, prefix: "A", rows: 4, cols: 6 },
    { roomId: 2, prefix: "B", rows: 5, cols: 6 },
    { roomId: 3, prefix: "C", rows: 4, cols: 5 }
  ];
  let seatId = 1;
  for (const cfg of roomConfigs) {
    for (let row = 1; row <= cfg.rows; row += 1) {
      for (let col = 1; col <= cfg.cols; col += 1) {
        seats.push({
          id: seatId,
          roomId: cfg.roomId,
          seatNo: `${cfg.prefix}${row}-${String(col).padStart(2, "0")}`,
          posX: col,
          posY: row,
          hasPower: col % 2 === 0,
          status: seatId % 17 === 0 ? "MAINTENANCE" : "NORMAL",
          createdAt: now,
          updatedAt: now
        });
        seatId += 1;
      }
    }
  }

  return {
    meta: { nextIds: { booking: 1, violation: 1, notice: 1, audit: 1, statusLog: 1 }, createdAt: now },
    users: [
      { id: 1, accountNo: "20230001", password: "123456", name: "李同学", college: "计算机学院", role: "STUDENT", status: "NORMAL" },
      { id: 2, accountNo: "20230002", password: "123456", name: "王同学", college: "外国语学院", role: "STUDENT", status: "NORMAL" },
      { id: 3, accountNo: "admin", password: "admin123", name: "楼宇管理员", college: "图书馆", role: "ADMIN", status: "NORMAL", scopeRoomIds: [1, 2, 3] },
      { id: 4, accountNo: "super", password: "super123", name: "超级管理员", college: "信息中心", role: "SUPER_ADMIN", status: "NORMAL" }
    ],
    sessions: [],
    campuses: [{ id: 1, name: "主校区", address: "校园东区", status: "OPEN" }],
    buildings: [
      { id: 1, campusId: 1, name: "图书馆", location: "中心广场", status: "OPEN" },
      { id: 2, campusId: 1, name: "第二教学楼", location: "教学区", status: "OPEN" }
    ],
    rooms: [
      { id: 1, buildingId: 1, floorNo: "2F", name: "静思自习室 A201", capacity: 24, openStatus: "OPEN" },
      { id: 2, buildingId: 1, floorNo: "3F", name: "研学自习室 A305", capacity: 30, openStatus: "OPEN" },
      { id: 3, buildingId: 2, floorNo: "1F", name: "公共自习室 B110", capacity: 20, openStatus: "OPEN" }
    ],
    openPeriods: [
      { id: 1, roomId: 1, weekday: "*", startTime: "08:00", endTime: "22:30", status: "OPEN" },
      { id: 2, roomId: 2, weekday: "*", startTime: "08:30", endTime: "22:00", status: "OPEN" },
      { id: 3, roomId: 3, weekday: "*", startTime: "07:30", endTime: "21:30", status: "OPEN" }
    ],
    seats,
    bookings: [],
    checkins: [],
    violations: [],
    notices: [],
    auditLogs: [],
    seatStatusLogs: [],
    rule: {
      advanceDays: 7,
      maxDurationHours: 4,
      graceMinutes: 15,
      dailyLimit: 3,
      tempLeaveMinutes: 30,
      violationThreshold: 3,
      restrictionDays: 7
    }
  };
}

function readDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function nextId(db, key) {
  const value = db.meta.nextIds[key] || 1;
  db.meta.nextIds[key] = value + 1;
  return value;
}

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function ok(res, data = null, message = "ok") {
  jsonResponse(res, 200, { code: "OK", message, data });
}

function fail(res, status, code, message, data = null) {
  jsonResponse(res, status, { code, message, data });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function getToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return "";
}

function authenticate(req, db) {
  const token = getToken(req);
  if (!token) return null;
  const session = db.sessions.find(item => item.token === token);
  if (!session) return null;
  const user = db.users.find(item => item.id === session.userId && item.status !== "DISABLED");
  return user || null;
}

function requireAuth(req, res, db) {
  const user = authenticate(req, db);
  if (!user) {
    fail(res, 401, "AUTH_401", "请先登录或重新登录");
    return null;
  }
  return user;
}

function requireAdmin(req, res, db) {
  const user = requireAuth(req, res, db);
  if (!user) return null;
  if (!ADMIN_ROLES.has(user.role)) {
    fail(res, 403, "PERM_403", "无管理员权限");
    return null;
  }
  return user;
}

function toDateTime(date, time) {
  return new Date(`${date}T${time}:00`);
}

function isValidDateTime(date, startTime, endTime) {
  const start = toDateTime(date, startTime);
  const end = toDateTime(date, endTime);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start;
}

function hoursBetween(start, end) {
  return (end.getTime() - start.getTime()) / 3600000;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function sameDate(iso, date) {
  return (iso || "").slice(0, 10) === date;
}

function audit(db, operatorId, action, targetType, targetId, beforeValue, afterValue) {
  db.auditLogs.push({
    id: nextId(db, "audit"),
    operatorId,
    action,
    targetType,
    targetId,
    beforeValue,
    afterValue,
    createdAt: new Date().toISOString()
  });
}

function notify(db, userId, type, title, content) {
  db.notices.push({
    id: nextId(db, "notice"),
    userId,
    type,
    title,
    content,
    readStatus: "UNREAD",
    createdAt: new Date().toISOString()
  });
}

function addViolation(db, userId, bookingId, type) {
  const occurredAt = new Date().toISOString();
  const userViolations = db.violations.filter(v => v.userId === userId && v.status === "ACTIVE");
  let limitUntil = null;
  if (userViolations.length + 1 >= db.rule.violationThreshold) {
    const until = new Date();
    until.setDate(until.getDate() + db.rule.restrictionDays);
    limitUntil = until.toISOString();
  }
  const violation = {
    id: nextId(db, "violation"),
    userId,
    bookingId,
    type,
    occurredAt,
    status: "ACTIVE",
    limitUntil
  };
  db.violations.push(violation);
  return violation;
}

function expireOverdueBookings(db) {
  const now = new Date();
  for (const booking of db.bookings) {
    if (booking.status !== "PENDING_CHECKIN") continue;
    const start = new Date(booking.startAt);
    const deadline = new Date(start.getTime() + db.rule.graceMinutes * 60000);
    if (now > deadline) {
      booking.status = "EXPIRED";
      booking.updatedAt = now.toISOString();
      addViolation(db, booking.userId, booking.id, "NO_SHOW");
      notify(db, booking.userId, "BOOKING_EXPIRED", "预约已超时释放", "您有一条预约未在规定时间内签到，座位已释放。");
      db.seatStatusLogs.push({
        id: nextId(db, "statusLog"),
        seatId: booking.seatId,
        bookingId: booking.id,
        oldStatus: "PENDING_CHECKIN",
        newStatus: "EXPIRED",
        reason: "超时未签到自动释放",
        createdAt: now.toISOString()
      });
    }
  }
}

function roomIsOpen(db, roomId, date, startTime, endTime) {
  const room = db.rooms.find(item => item.id === roomId);
  if (!room || room.openStatus !== "OPEN") return false;
  const periods = db.openPeriods.filter(item => item.roomId === roomId && item.status === "OPEN");
  return periods.some(period => startTime >= period.startTime && endTime <= period.endTime);
}

function seatDisplayStatus(db, seat, date, startTime, endTime) {
  if (seat.status === "DISABLED") return "DISABLED";
  if (seat.status === "MAINTENANCE") return "MAINTENANCE";
  if (!roomIsOpen(db, seat.roomId, date, startTime, endTime)) return "CLOSED";
  const start = toDateTime(date, startTime);
  const end = toDateTime(date, endTime);
  const active = db.bookings.find(booking => {
    if (booking.seatId !== seat.id || !ACTIVE_BOOKING_STATUSES.has(booking.status)) return false;
    return rangesOverlap(start, end, new Date(booking.startAt), new Date(booking.endAt));
  });
  if (!active) return "FREE";
  if (active.status === "IN_USE") return "IN_USE";
  if (active.status === "TEMP_LEAVE") return "TEMP_LEAVE";
  return "RESERVED";
}

function roomStats(db, room, date, startTime, endTime) {
  const seats = db.seats.filter(seat => seat.roomId === room.id);
  const statusCount = seats.reduce((acc, seat) => {
    const status = seatDisplayStatus(db, seat, date, startTime, endTime);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    totalSeats: seats.length,
    freeSeats: statusCount.FREE || 0,
    reservedSeats: statusCount.RESERVED || 0,
    inUseSeats: statusCount.IN_USE || 0,
    unavailableSeats: (statusCount.MAINTENANCE || 0) + (statusCount.DISABLED || 0) + (statusCount.CLOSED || 0)
  };
}

function validateBooking(db, user, seatId, date, startTime, endTime) {
  if (!isValidDateTime(date, startTime, endTime)) return "预约时间不合法";
  const start = toDateTime(date, startTime);
  const end = toDateTime(date, endTime);
  const now = new Date();
  if (start < now) return "不能预约过去的时间段";
  const maxDate = new Date(now);
  maxDate.setDate(maxDate.getDate() + db.rule.advanceDays);
  if (start > maxDate) return `最多只能提前 ${db.rule.advanceDays} 天预约`;
  if (hoursBetween(start, end) > db.rule.maxDurationHours) return `单次预约不能超过 ${db.rule.maxDurationHours} 小时`;

  const restricted = db.violations.find(v => v.userId === user.id && v.limitUntil && new Date(v.limitUntil) > now);
  if (restricted) return `当前账号存在预约限制，到期时间：${restricted.limitUntil.slice(0, 16).replace("T", " ")}`;

  const dailyCount = db.bookings.filter(b => b.userId === user.id && sameDate(b.startAt, date) && ACTIVE_BOOKING_STATUSES.has(b.status)).length;
  if (dailyCount >= db.rule.dailyLimit) return `每日最多保留 ${db.rule.dailyLimit} 条有效预约`;

  const seat = db.seats.find(item => item.id === seatId);
  if (!seat) return "座位不存在";
  if (seat.status !== "NORMAL") return "该座位当前不可预约";
  if (!roomIsOpen(db, seat.roomId, date, startTime, endTime)) return "该房间在所选时间段未开放";

  const userConflict = db.bookings.find(b => {
    if (b.userId !== user.id || !ACTIVE_BOOKING_STATUSES.has(b.status)) return false;
    return rangesOverlap(start, end, new Date(b.startAt), new Date(b.endAt));
  });
  if (userConflict) return "您在该时段已有有效预约";

  const seatConflict = db.bookings.find(b => {
    if (b.seatId !== seatId || !ACTIVE_BOOKING_STATUSES.has(b.status)) return false;
    return rangesOverlap(start, end, new Date(b.startAt), new Date(b.endAt));
  });
  if (seatConflict) return "该座位已被预约";
  return "";
}

function enrichBooking(db, booking) {
  const seat = db.seats.find(item => item.id === booking.seatId);
  const room = seat ? db.rooms.find(item => item.id === seat.roomId) : null;
  const building = room ? db.buildings.find(item => item.id === room.buildingId) : null;
  const user = db.users.find(item => item.id === booking.userId);
  return {
    ...booking,
    user: publicUser(user),
    seat,
    room,
    building
  };
}

function routeMatch(pathname, pattern) {
  const a = pathname.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < b.length; i += 1) {
    if (b[i].startsWith(":")) {
      params[b[i].slice(1)] = a[i];
    } else if (a[i] !== b[i]) {
      return null;
    }
  }
  return params;
}

async function handleApi(req, res) {
  const db = readDb();
  expireOverdueBookings(db);
  const url = parseUrl(req);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      writeDb(db);
      return ok(res, { status: "UP", time: new Date().toISOString() });
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const user = db.users.find(item => item.accountNo === body.account && item.password === body.password && item.status !== "DISABLED");
      if (!user) return fail(res, 401, "AUTH_401", "账号或密码错误");
      const token = crypto.randomBytes(24).toString("hex");
      db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
      audit(db, user.id, "LOGIN", "sys_user", user.id, null, "登录成功");
      writeDb(db);
      return ok(res, { token, user: publicUser(user) });
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const token = getToken(req);
      const before = db.sessions.length;
      db.sessions = db.sessions.filter(item => item.token !== token);
      writeDb(db);
      return ok(res, { removed: before - db.sessions.length });
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      writeDb(db);
      return ok(res, publicUser(user));
    }

    if (req.method === "GET" && pathname === "/api/bootstrap") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      writeDb(db);
      return ok(res, {
        user: publicUser(user),
        campuses: db.campuses,
        buildings: db.buildings,
        rule: db.rule,
        roles: { admin: ADMIN_ROLES.has(user.role) }
      });
    }

    if (req.method === "GET" && pathname === "/api/rooms") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const startTime = url.searchParams.get("startTime") || "09:00";
      const endTime = url.searchParams.get("endTime") || "11:00";
      const buildingId = Number(url.searchParams.get("buildingId") || 0);
      const rooms = db.rooms
        .filter(room => !buildingId || room.buildingId === buildingId)
        .map(room => ({ ...room, building: db.buildings.find(b => b.id === room.buildingId), stats: roomStats(db, room, date, startTime, endTime) }));
      writeDb(db);
      return ok(res, rooms);
    }

    const roomSeatParams = routeMatch(pathname, "/api/rooms/:id/seats");
    if (req.method === "GET" && roomSeatParams) {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const roomId = Number(roomSeatParams.id);
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const startTime = url.searchParams.get("startTime") || "09:00";
      const endTime = url.searchParams.get("endTime") || "11:00";
      const room = db.rooms.find(item => item.id === roomId);
      if (!room) return fail(res, 404, "ROOM_404", "房间不存在");
      const seats = db.seats
        .filter(seat => seat.roomId === roomId)
        .map(seat => ({ ...seat, displayStatus: seatDisplayStatus(db, seat, date, startTime, endTime) }));
      writeDb(db);
      return ok(res, { room, seats, legend: ["FREE", "RESERVED", "IN_USE", "TEMP_LEAVE", "MAINTENANCE", "DISABLED", "CLOSED"] });
    }

    if (req.method === "POST" && pathname === "/api/bookings") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const body = await parseBody(req);
      const seatId = Number(body.seatId);
      const message = validateBooking(db, user, seatId, body.date, body.startTime, body.endTime);
      if (message) return fail(res, 409, "BOOKING_409", message);
      const now = new Date().toISOString();
      const booking = {
        id: nextId(db, "booking"),
        userId: user.id,
        seatId,
        startAt: toDateTime(body.date, body.startTime).toISOString(),
        endAt: toDateTime(body.date, body.endTime).toISOString(),
        status: "PENDING_CHECKIN",
        cancelReason: "",
        createdAt: now,
        updatedAt: now
      };
      db.bookings.push(booking);
      notify(db, user.id, "BOOKING_SUCCESS", "预约成功", "请在预约开始后按时到场扫码签到。");
      audit(db, user.id, "CREATE", "booking_order", booking.id, null, booking);
      writeDb(db);
      return ok(res, enrichBooking(db, booking), "预约成功");
    }

    if (req.method === "GET" && pathname === "/api/bookings") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const scope = url.searchParams.get("scope") || "mine";
      let bookings = db.bookings;
      if (scope !== "all" || !ADMIN_ROLES.has(user.role)) bookings = bookings.filter(item => item.userId === user.id);
      bookings = bookings.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(item => enrichBooking(db, item));
      writeDb(db);
      return ok(res, bookings);
    }

    const cancelParams = routeMatch(pathname, "/api/bookings/:id/cancel");
    if (req.method === "POST" && cancelParams) {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const booking = db.bookings.find(item => item.id === Number(cancelParams.id));
      if (!booking) return fail(res, 404, "BOOKING_404", "预约不存在");
      if (booking.userId !== user.id && !ADMIN_ROLES.has(user.role)) return fail(res, 403, "PERM_403", "不能取消他人预约");
      if (!ACTIVE_BOOKING_STATUSES.has(booking.status)) return fail(res, 400, "BOOKING_400", "当前预约状态不能取消");
      const body = await parseBody(req);
      const before = { ...booking };
      booking.status = "CANCELLED";
      booking.cancelReason = body.reason || "用户取消";
      booking.updatedAt = new Date().toISOString();
      audit(db, user.id, "CANCEL", "booking_order", booking.id, before, booking);
      writeDb(db);
      return ok(res, enrichBooking(db, booking), "已取消预约");
    }

    if (req.method === "POST" && pathname === "/api/checkins") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const body = await parseBody(req);
      const booking = db.bookings.find(item => item.id === Number(body.bookingId));
      if (!booking) return fail(res, 404, "BOOKING_404", "预约不存在");
      if (booking.userId !== user.id && !ADMIN_ROLES.has(user.role)) return fail(res, 403, "PERM_403", "不能为该预约签到");
      if (booking.status !== "PENDING_CHECKIN") return fail(res, 400, "CHECKIN_400", "当前预约不能签到");
      const now = new Date();
      const start = new Date(booking.startAt);
      const deadline = new Date(start.getTime() + db.rule.graceMinutes * 60000);
      if (now > deadline) return fail(res, 410, "CHECKIN_410", "签到已超时，座位已释放");
      const before = { ...booking };
      booking.status = "IN_USE";
      booking.updatedAt = now.toISOString();
      const checkin = {
        id: db.checkins.length + 1,
        bookingId: booking.id,
        userId: booking.userId,
        checkinTime: now.toISOString(),
        method: "QR_CODE",
        result: "SUCCESS"
      };
      db.checkins.push(checkin);
      audit(db, user.id, "CHECKIN", "booking_order", booking.id, before, booking);
      writeDb(db);
      return ok(res, { booking: enrichBooking(db, booking), checkin }, "签到成功");
    }

    const leaveParams = routeMatch(pathname, "/api/bookings/:id/leave");
    if (req.method === "POST" && leaveParams) {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const booking = db.bookings.find(item => item.id === Number(leaveParams.id));
      if (!booking) return fail(res, 404, "BOOKING_404", "预约不存在");
      if (booking.userId !== user.id) return fail(res, 403, "PERM_403", "不能操作他人预约");
      if (booking.status !== "IN_USE") return fail(res, 400, "BOOKING_400", "仅使用中的预约可以暂离");
      const before = { ...booking };
      booking.status = "TEMP_LEAVE";
      booking.leaveStartedAt = new Date().toISOString();
      booking.updatedAt = booking.leaveStartedAt;
      audit(db, user.id, "TEMP_LEAVE", "booking_order", booking.id, before, booking);
      writeDb(db);
      return ok(res, enrichBooking(db, booking), "已进入暂离状态");
    }

    const finishParams = routeMatch(pathname, "/api/bookings/:id/finish");
    if (req.method === "POST" && finishParams) {
      const user = requireAuth(req, res, db);
      if (!user) return;
      const booking = db.bookings.find(item => item.id === Number(finishParams.id));
      if (!booking) return fail(res, 404, "BOOKING_404", "预约不存在");
      if (booking.userId !== user.id && !ADMIN_ROLES.has(user.role)) return fail(res, 403, "PERM_403", "不能结束该预约");
      if (!["IN_USE", "TEMP_LEAVE"].includes(booking.status)) return fail(res, 400, "BOOKING_400", "当前预约不能结束");
      const before = { ...booking };
      booking.status = "COMPLETED";
      booking.updatedAt = new Date().toISOString();
      audit(db, user.id, "FINISH", "booking_order", booking.id, before, booking);
      writeDb(db);
      return ok(res, enrichBooking(db, booking), "已结束使用");
    }

    if (req.method === "GET" && pathname === "/api/notices") {
      const user = requireAuth(req, res, db);
      if (!user) return;
      writeDb(db);
      return ok(res, db.notices.filter(item => item.userId === user.id).slice(-20).reverse());
    }

    if (req.method === "GET" && pathname === "/api/admin/resources") {
      const user = requireAdmin(req, res, db);
      if (!user) return;
      writeDb(db);
      return ok(res, { campuses: db.campuses, buildings: db.buildings, rooms: db.rooms, seats: db.seats, openPeriods: db.openPeriods });
    }

    const adminSeatParams = routeMatch(pathname, "/api/admin/seats/:id");
    if (req.method === "PUT" && adminSeatParams) {
      const user = requireAdmin(req, res, db);
      if (!user) return;
      const seat = db.seats.find(item => item.id === Number(adminSeatParams.id));
      if (!seat) return fail(res, 404, "SEAT_404", "座位不存在");
      const body = await parseBody(req);
      const before = { ...seat };
      if (["NORMAL", "MAINTENANCE", "DISABLED"].includes(body.status)) seat.status = body.status;
      if (typeof body.hasPower === "boolean") seat.hasPower = body.hasPower;
      seat.updatedAt = new Date().toISOString();
      audit(db, user.id, "UPDATE", "space_seat", seat.id, before, seat);
      writeDb(db);
      return ok(res, seat, "座位已更新");
    }

    if (req.method === "PUT" && pathname === "/api/admin/rules") {
      const user = requireAdmin(req, res, db);
      if (!user) return;
      const body = await parseBody(req);
      const before = { ...db.rule };
      for (const key of ["advanceDays", "maxDurationHours", "graceMinutes", "dailyLimit", "tempLeaveMinutes", "violationThreshold", "restrictionDays"]) {
        if (body[key] !== undefined) db.rule[key] = Number(body[key]);
      }
      audit(db, user.id, "UPDATE", "booking_rule", 1, before, db.rule);
      writeDb(db);
      return ok(res, db.rule, "规则已保存");
    }

    if (req.method === "GET" && pathname === "/api/admin/statistics") {
      const user = requireAdmin(req, res, db);
      if (!user) return;
      const total = db.bookings.length;
      const checkedIn = db.bookings.filter(item => ["IN_USE", "TEMP_LEAVE", "COMPLETED"].includes(item.status)).length;
      const expired = db.bookings.filter(item => item.status === "EXPIRED").length;
      const active = db.bookings.filter(item => ACTIVE_BOOKING_STATUSES.has(item.status)).length;
      const byRoom = db.rooms.map(room => {
        const roomSeatIds = db.seats.filter(seat => seat.roomId === room.id).map(seat => seat.id);
        const roomBookings = db.bookings.filter(booking => roomSeatIds.includes(booking.seatId));
        return { roomId: room.id, roomName: room.name, bookings: roomBookings.length, active: roomBookings.filter(b => ACTIVE_BOOKING_STATUSES.has(b.status)).length };
      });
      writeDb(db);
      return ok(res, {
        totalBookings: total,
        activeBookings: active,
        checkinRate: total ? Number((checkedIn / total).toFixed(2)) : 0,
        violationRate: total ? Number((expired / total).toFixed(2)) : 0,
        violations: db.violations.length,
        byRoom,
        recentAuditLogs: db.auditLogs.slice(-15).reverse()
      });
    }

    writeDb(db);
    return fail(res, 404, "API_404", "接口不存在");
  } catch (error) {
    writeDb(db);
    return fail(res, 500, "SYS_500", error.message || "系统异常");
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const url = parseUrl(req);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(FRONTEND_DIR, pathname));
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(FRONTEND_DIR, "index.html"), (fallbackErr, fallback) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end("Not Found");
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(fallback);
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

ensureDataFile();

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Study room reservation system running at http://localhost:${PORT}`);
});
