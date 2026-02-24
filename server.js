const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3471;

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
const HELPERS_FILE = path.join(DATA_DIR, 'helpers.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Load/save helpers
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error(`Error loading ${file}:`, e.message); }
  return fallback;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// In-memory data
let tasks = loadJSON(TASKS_FILE, []);
let visits = loadJSON(VISITS_FILE, []);
let helpers = loadJSON(HELPERS_FILE, []);
let config = loadJSON(CONFIG_FILE, { pin: '0000' });

function saveTasks() { saveJSON(TASKS_FILE, tasks); }
function saveVisits() { saveJSON(VISITS_FILE, visits); }
function saveHelpers() { saveJSON(HELPERS_FILE, helpers); }
function saveConfig() { saveJSON(CONFIG_FILE, config); }

// Middleware
app.use(express.json());

// Static files
app.use('/manifest.json', express.static(path.join(__dirname, 'manifest.json')));
app.use('/service-worker.js', express.static(path.join(__dirname, 'service-worker.js')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- REST API ---

// Tasks
app.get('/api/tasks', (req, res) => res.json(tasks));

app.post('/api/tasks', (req, res) => {
  const { title, description, category, desiredDate, desiredTime, twin } = req.body;
  const task = {
    id: uuidv4(),
    title,
    description: description || '',
    category: category || '📦 기타',
    desiredDate: desiredDate || '',
    desiredTime: desiredTime || '',
    twin: twin || '',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
  };
  tasks.unshift(task);
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(tasks[idx], req.body);
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json({ ok: true });
});

// Claim a task
app.post('/api/tasks/:id/claim', (req, res) => {
  const { helperName } = req.body;
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.status = 'reserved';
  task.claimedBy = helperName;
  task.claimedAt = new Date().toISOString();
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json(task);
});

// Unclaim a task
app.post('/api/tasks/:id/unclaim', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.status = 'waiting';
  task.claimedBy = null;
  task.claimedAt = null;
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json(task);
});

// Complete a task
app.post('/api/tasks/:id/complete', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  saveTasks();
  io.emit('tasks:update', tasks);
  res.json(task);
});

// Visits (time slots)
app.get('/api/visits', (req, res) => res.json(visits));

app.post('/api/visits', (req, res) => {
  const { date, startTime, endTime } = req.body;
  const visit = {
    id: uuidv4(),
    date,
    startTime,
    endTime,
    bookedBy: null,
    bookedAt: null,
    createdAt: new Date().toISOString(),
  };
  visits.push(visit);
  saveVisits();
  io.emit('visits:update', visits);
  res.json(visit);
});

app.post('/api/visits/:id/book', (req, res) => {
  const { helperName } = req.body;
  const visit = visits.find(v => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });
  if (visit.bookedBy) return res.status(409).json({ error: 'Already booked' });
  visit.bookedBy = helperName;
  visit.bookedAt = new Date().toISOString();
  saveVisits();
  io.emit('visits:update', visits);
  res.json(visit);
});

app.post('/api/visits/:id/unbook', (req, res) => {
  const visit = visits.find(v => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });
  visit.bookedBy = null;
  visit.bookedAt = null;
  saveVisits();
  io.emit('visits:update', visits);
  res.json(visit);
});

app.delete('/api/visits/:id', (req, res) => {
  visits = visits.filter(v => v.id !== req.params.id);
  saveVisits();
  io.emit('visits:update', visits);
  res.json({ ok: true });
});

// Helpers
app.get('/api/helpers', (req, res) => res.json(helpers));

app.post('/api/helpers', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const existing = helpers.find(h => h.name === name.trim());
  if (existing) return res.json(existing);
  const helper = { id: uuidv4(), name: name.trim(), joinedAt: new Date().toISOString() };
  helpers.push(helper);
  saveHelpers();
  io.emit('helpers:update', helpers);
  res.json(helper);
});

// PIN verify
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  res.json({ ok: pin === config.pin });
});

app.post('/api/set-pin', (req, res) => {
  const { oldPin, newPin } = req.body;
  if (oldPin !== config.pin) return res.status(403).json({ error: 'Wrong PIN' });
  config.pin = newPin;
  saveConfig();
  res.json({ ok: true });
});

// Socket.io
io.on('connection', (socket) => {
  socket.emit('tasks:update', tasks);
  socket.emit('visits:update', visits);
  socket.emit('helpers:update', helpers);
});

server.listen(PORT, () => {
  console.log(`도움반 running on http://localhost:${PORT}`);
});
