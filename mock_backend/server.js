
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ==========================================
// 1. CONFIGURATION
// ==========================================

const PORT = process.env.PORT || 3000;

const COMPANY_TIMEZONE = 'Asia/Kolkata';
const OFFICE_RADIUS_METERS = 200;

// TEST OFFICE LOCATION
// Matches the GPS coordinates shared from your phone.
// Keep these identical in Flutter.
const OFFICE_LOCATION = {
  latitude: 9.743375,
  longitude: 77.2096917,
};

const employee = {
  employeeName: 'Jithu Mathew',
  employeeId: 'EMP001',
  department: 'Development',
};

const INITIAL_LEAVE_BALANCE = {
  Casual: 6,
  Sick: 6,
};

app.use(cors());
app.use(express.json());

// ==========================================
// 2. LOCAL JSON DATABASE
// ==========================================

const DATA_FILE = path.join(__dirname, 'data.json');

function loadDatabase() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(
        fs.readFileSync(DATA_FILE, 'utf8')
      );

      // Ensure all required collections exist.
      data.attendanceRecords ??= [];
      data.processedEvents ??= [];
      data.leaveRequests ??= [];

      return data;
    } catch (error) {
      console.error('Could not read data.json:', error);
      throw error;
    }
  }

  const initialData = {
    attendanceRecords: [
      {
        date: '2026-11-14',
        checkIn: '09:15',
        checkOut: '18:00',
        status: 'Present',
      },
      {
        date: '2026-11-13',
        checkIn: '09:05',
        checkOut: '18:00',
        status: 'Present',
      },
    ],
    processedEvents: [],
    leaveRequests: [],
  };

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(initialData, null, 2)
  );

  return initialData;
}

let db = loadDatabase();

function saveDatabase() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(db, null, 2)
  );
}

// ==========================================
// 3. HELPER FUNCTIONS
// ==========================================

function getCompanyDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPANY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = {};

  parts.forEach((part) => {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  });

  return `${values.year}-${values.month}-${values.day}`;
}

function getCompanyTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPANY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function isValidDateString(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function calculateDays(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);

  return Math.floor((end - start) / 86400000) + 1;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;

  const toRadians = (degree) =>
    degree * Math.PI / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) ** 2;

  const c =
    2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadius * c;
}

function calculateLeaveBalances() {
  const balances = { ...INITIAL_LEAVE_BALANCE };

  db.leaveRequests.forEach((request) => {
    if (
      request.status === 'Pending' ||
      request.status === 'Approved'
    ) {
      balances[request.leaveType] -=
        request.requestedDays;
    }
  });

  balances.Casual = Math.max(0, balances.Casual);
  balances.Sick = Math.max(0, balances.Sick);

  return balances;
}

// ==========================================
// 4. MOCK SCENARIO MIDDLEWARE
// ==========================================

// Header: x-mock-scenario
//
// slow                         -> 15-second delay
// server-error                 -> HTTP 500
// duplicate-attendance-conflict -> HTTP 409
// leave-validation-rejection   -> HTTP 422

app.use(async (req, res, next) => {
  const scenario = req.headers['x-mock-scenario'];

  if (scenario === 'slow') {
    await new Promise((resolve) =>
      setTimeout(resolve, 15000)
    );
  }

  if (scenario === 'server-error') {
    return res.status(500).json({
      message: 'Simulated internal server error',
    });
  }

  next();
});

// ==========================================
// 5. EMPLOYEE API
// ==========================================

// GET /employee/me

app.get('/employee/me', (req, res) => {
  const balances = calculateLeaveBalances();

  res.json({
    ...employee,
    leaveBalance:
      balances.Casual + balances.Sick,
    leaveBalances: balances,
    office: {
      latitude: OFFICE_LOCATION.latitude,
      longitude: OFFICE_LOCATION.longitude,
      radiusMeters: OFFICE_RADIUS_METERS,
      timezone: COMPANY_TIMEZONE,
    },
  });
});

// ==========================================
// 6. ATTENDANCE HISTORY API
// ==========================================

// GET /attendance?month=2026-11

app.get('/attendance', (req, res) => {
  const month = req.query.month;

  if (
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    return res.status(400).json({
      message: 'Month must use YYYY-MM format',
    });
  }

  const records = db.attendanceRecords
    .filter((record) =>
      record.date.startsWith(month)
    )
    .sort((a, b) =>
      b.date.localeCompare(a.date)
    )
    .map(({ date, checkIn, checkOut, status }) => ({
      date,
      checkIn,
      checkOut,
      status,
    }));

  res.json({
    attendance: records,
  });
});

// ==========================================
// 7. ATTENDANCE CHECK-IN / CHECK-OUT
// ==========================================

// POST /attendance/events

app.post('/attendance/events', (req, res) => {
  const {
    eventId,
    eventType,
    timestamp,
    latitude,
    longitude,
  } = req.body;

  // Validate request
  if (
    typeof eventId !== 'string' ||
    !eventId.trim() ||
    eventId.length > 100 ||
    !['CHECK_IN', 'CHECK_OUT'].includes(eventType) ||
    typeof timestamp !== 'string' ||
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({
      message: 'Invalid attendance event data',
    });
  }

  const eventDate = new Date(timestamp);

  if (Number.isNaN(eventDate.getTime())) {
    return res.status(400).json({
      message: 'Invalid timestamp',
    });
  }

  // Idempotency: check whether this event was already processed.
  const existingEvent = db.processedEvents.find(
    (event) => event.eventId === eventId
  );

  if (existingEvent) {
    const samePayload =
      existingEvent.eventType === eventType &&
      existingEvent.timestamp === eventDate.toISOString() &&
      existingEvent.latitude === latitude &&
      existingEvent.longitude === longitude;

    if (!samePayload) {
      return res.status(409).json({
        message: 'Event ID already used with different data',
      });
    }

    return res.status(200).json({
      message: 'Event already processed',
      ...existingEvent.response,
      duplicate: true,
    });
  }

  // Repeatable duplicate conflict scenario
  if (
    req.headers['x-mock-scenario'] ===
    'duplicate-attendance-conflict'
  ) {
    return res.status(409).json({
      message: 'Simulated duplicate attendance conflict',
    });
  }

  // Server-side GPS validation
  const distance = calculateDistance(
    latitude,
    longitude,
    OFFICE_LOCATION.latitude,
    OFFICE_LOCATION.longitude
  );

  if (distance > OFFICE_RADIUS_METERS) {
    return res.status(403).json({
      message: 'You are outside the permitted office area',
      distanceMeters: Math.round(distance),
      allowedDistanceMeters: OFFICE_RADIUS_METERS,
    });
  }

  const date = getCompanyDate(eventDate);
  const time = getCompanyTime(eventDate);

  let record = db.attendanceRecords.find(
    (item) => item.date === date
  );

  // CHECK IN
  if (eventType === 'CHECK_IN') {
    if (record && record.checkIn) {
      return res.status(409).json({
        message: 'Already checked in today',
      });
    }

    if (!record) {
      record = {
        date,
        checkIn: null,
        checkOut: null,
        status: 'Present',
      };

      db.attendanceRecords.push(record);
    }

    record.checkIn = time;
    record.checkInTimestamp =
      eventDate.toISOString();
  }

  // CHECK OUT
  if (eventType === 'CHECK_OUT') {
    if (!record || !record.checkIn) {
      return res.status(409).json({
        message: 'Please check in before checking out',
      });
    }

    if (record.checkOut) {
      return res.status(409).json({
        message: 'Already checked out today',
      });
    }

    if (
      record.checkInTimestamp &&
      eventDate <= new Date(record.checkInTimestamp)
    ) {
      return res.status(409).json({
        message: 'Checkout time must be after check-in',
      });
    }

    record.checkOut = time;
    record.checkOutTimestamp =
      eventDate.toISOString();
  }

  const result = {
    eventId,
    eventType,
    date,
    time,
    status: 'SYNCED',
  };

  // Save event ID and response for retry safety.
  db.processedEvents.push({
    eventId,
    eventType,
    timestamp: eventDate.toISOString(),
    latitude,
    longitude,
    response: result,
  });

  saveDatabase();

  return res.status(201).json({
    message: 'Attendance event recorded successfully',
    ...result,
    duplicate: false,
  });
});

// ==========================================
// 8. LEAVE BALANCE API
// ==========================================

// GET /leave/balance

app.get('/leave/balance', (req, res) => {
  const balances = calculateLeaveBalances();

  res.json({
    casual: balances.Casual,
    sick: balances.Sick,
    total: balances.Casual + balances.Sick,
  });
});

// ==========================================
// 9. LEAVE REQUEST HISTORY
// ==========================================

// GET /leave/requests

app.get('/leave/requests', (req, res) => {
  const requests = [...db.leaveRequests].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt)
  );

  res.json({
    requests,
  });
});

// ==========================================
// 10. SUBMIT LEAVE REQUEST
// ==========================================

// POST /leave/requests

app.post('/leave/requests', (req, res) => {
  const {
    leaveType,
    startDate,
    endDate,
    reason,
  } = req.body;

  // Repeatable server validation rejection
  if (
    req.headers['x-mock-scenario'] ===
    'leave-validation-rejection'
  ) {
    return res.status(422).json({
      message: 'Leave request rejected by mock server',
      errors: {
        reason: 'Simulated server-side validation failure',
      },
    });
  }

  const errors = {};

  // Leave type
  if (!['Casual', 'Sick'].includes(leaveType)) {
    errors.leaveType =
      'Select Casual or Sick leave';
  }

  // Start date
  if (!isValidDateString(startDate)) {
    errors.startDate = 'Invalid start date';
  } else if (
    startDate < getCompanyDate(new Date())
  ) {
    errors.startDate =
      'Start date cannot be in the past';
  }

  // End date
  if (!isValidDateString(endDate)) {
    errors.endDate = 'Invalid end date';
  }

  if (
    isValidDateString(startDate) &&
    isValidDateString(endDate) &&
    endDate < startDate
  ) {
    errors.endDate =
      'End date cannot be before start date';
  }

  // Reason
  if (
    typeof reason !== 'string' ||
    reason.trim().length < 10
  ) {
    errors.reason =
      'Reason must contain at least 10 non-whitespace characters';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(422).json({
      message: 'Leave validation failed',
      errors,
    });
  }

  const requestedDays = calculateDays(
    startDate,
    endDate
  );

  // Check available balance
  const balances = calculateLeaveBalances();

  if (requestedDays > balances[leaveType]) {
    errors.leaveBalance =
      `Only ${balances[leaveType]} ${leaveType} leave days are available`;
  }

  // Check overlapping Pending/Approved requests
  const overlappingRequest = db.leaveRequests.find(
    (request) => {
      const active =
        request.status === 'Pending' ||
        request.status === 'Approved';

      const overlaps =
        startDate <= request.endDate &&
        endDate >= request.startDate;

      return active && overlaps;
    }
  );

  if (overlappingRequest) {
    errors.dateOverlap =
      'Dates overlap an existing Pending or Approved leave request';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(422).json({
      message: 'Leave validation failed',
      errors,
    });
  }

  const newRequest = {
    id: `LEAVE-${crypto.randomUUID()}`,
    leaveType,
    startDate,
    endDate,
    reason: reason.trim(),
    requestedDays,
    status: 'Pending',
    createdAt: new Date().toISOString(),
  };

  db.leaveRequests.push(newRequest);

  saveDatabase();

  return res.status(201).json({
    message: 'Leave request submitted successfully',
    request: newRequest,
  });
});

// ==========================================
// 11. INVALID ENDPOINT
// ==========================================

app.use((req, res) => {
  res.status(404).json({
    message: 'API endpoint not found',
    path: req.originalUrl,
  });
});

// ==========================================
// 12. START SERVER
// ==========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log('REBS HRMS Mock API Started');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Office latitude: ${OFFICE_LOCATION.latitude}`);
  console.log(`Office longitude: ${OFFICE_LOCATION.longitude}`);
  console.log(`Allowed radius: ${OFFICE_RADIUS_METERS} metres`);
  console.log('Timezone: ' + COMPANY_TIMEZONE);
  console.log('================================');
});
