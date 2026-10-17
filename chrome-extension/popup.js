const questionInput = document.getElementById('question');
const askBtn = document.getElementById('askBtn');
const summaryBtn = document.getElementById('summaryBtn');
const outputBox = document.getElementById('outputBox');
const answerText = document.getElementById('answerText');
const sourcesEl = document.getElementById('sources');
const historyList = document.getElementById('historyList');
const notesList = document.getElementById('notesList');
const noteInput = document.getElementById('noteInput');
const saveNoteBtn = document.getElementById('saveNoteBtn');
const startTimeInput = document.getElementById('startTime');
const endTimeInput = document.getElementById('endTime');
const apiUrlInput = document.getElementById('apiUrlInput');
const statusDot = document.getElementById('statusDot');
const HISTORY_KEY = 'youtube-rag-history';
const STUDY_KEY = 'youtube-rag-study-memory';
const API_BASE_URL_KEY = 'youtube-rag-api-base-url';
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';
const MAX_HISTORY_ITEMS = 8;

function saveApiBaseUrl(url) {
  const normalized = (url || DEFAULT_API_BASE_URL).trim().replace(/\/$/, '');
  localStorage.setItem(API_BASE_URL_KEY, normalized);
  if (apiUrlInput) {
    apiUrlInput.value = normalized;
  }
  return normalized;
}

function loadApiBaseUrl() {
  try {
    const stored = localStorage.getItem(API_BASE_URL_KEY);
    const value = stored && stored.trim() ? stored.trim() : DEFAULT_API_BASE_URL;
    return saveApiBaseUrl(value);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function buildApiUrl(path) {
  return `${loadApiBaseUrl()}${path}`;
}

const API_URL = buildApiUrl('/api/chat');
const SUMMARY_URL = buildApiUrl('/api/summary');

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

function loadStudyMemory() {
  try {
    const data = JSON.parse(localStorage.getItem(STUDY_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveStudyMemory(data) {
  localStorage.setItem(STUDY_KEY, JSON.stringify(data));
}

function createEmptyState(message) {
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.textContent = message;
  return li;
}

function getVideoState(videoId) {
  const memory = loadStudyMemory();
  const current = memory[videoId] || { conversations: [], notes: [] };
  return {
    conversations: Array.isArray(current.conversations) ? current.conversations : [],
    notes: Array.isArray(current.notes) ? current.notes : [],
  };
}

function setVideoState(videoId, state) {
  const memory = loadStudyMemory();
  memory[videoId] = {
    conversations: Array.isArray(state.conversations) ? state.conversations : [],
    notes: Array.isArray(state.notes) ? state.notes : [],
    updatedAt: Date.now(),
  };
  saveStudyMemory(memory);
}

function prettifyTime(value) {
  if (!value) return 'just now';
  try {
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'just now';
  }
}

function renderNotes(notes) {
  notesList.innerHTML = '';

  if (!notes.length) {
    notesList.appendChild(createEmptyState('No saved notes for this video yet.'));
    return;
  }

  notes.forEach((note) => {
    const li = document.createElement('li');
    li.className = 'note-item';

    const body = document.createElement('div');
    body.className = 'note-text';
    body.textContent = note.text;

    const button = document.createElement('button');
    button.className = 'note-delete';
    button.type = 'button';
    button.textContent = 'Delete';
    button.addEventListener('click', () => {
      deleteNoteForCurrentVideo(note.id);
    });

    li.appendChild(body);
    li.appendChild(button);
    notesList.appendChild(li);
  });
}

function renderHistory(history) {
  historyList.innerHTML = '';

  if (!history.length) {
    historyList.appendChild(createEmptyState('No saved conversations for this video yet.'));
    return;
  }

  history.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const question = document.createElement('div');
    question.className = 'history-question';
    question.textContent = item.question;

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = `${prettifyTime(item.createdAt)} • ${item.answer ? 'answer ready' : 'no answer yet'}`;

    li.appendChild(question);
    li.appendChild(meta);
    li.addEventListener('click', () => {
      questionInput.value = item.question;
      outputBox.hidden = false;
      answerText.textContent = item.answer || 'This answer was not saved.';
      answerText.classList.remove('error-text');
      sourcesEl.innerHTML = Array.isArray(item.sources) && item.sources.length
        ? item.sources
            .map((source, index) => `<div class="source"><strong>Source ${index + 1}</strong><div>${source}</div></div>`)
            .join('')
        : '<div class="source"><strong>No supporting evidence found.</strong></div>';
    });

    historyList.appendChild(li);
  });
}

function addToHistory(text) {
  const clean = text.trim();
  if (!clean) return;
  const history = loadHistory();
  const updated = [clean, ...history.filter((item) => item !== clean)].slice(0, 6);
  saveHistory(updated);
}

function getCurrentVideoId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url || '';
      const match = currentUrl.match(/[?&]v=([^&#]+)/) || currentUrl.match(/youtu\.be\/([^?#]+)/);
      resolve(match ? decodeURIComponent(match[1]) : null);
    });
  });
}

function loadCurrentVideoHistory() {
  return getCurrentVideoId().then((videoId) => {
    if (!videoId) {
      renderHistory([]);
      renderNotes([]);
      return;
    }

    const state = getVideoState(videoId);
    renderHistory(state.conversations);
    renderNotes(state.notes);
  });
}

function addConversationEntry(question, answer, sources) {
  return getCurrentVideoId().then((videoId) => {
    if (!videoId) return;
    const state = getVideoState(videoId);
    const entry = {
      id: `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      question,
      answer,
      sources: Array.isArray(sources) ? sources : [],
      createdAt: new Date().toISOString(),
    };

    state.conversations = [entry, ...state.conversations].slice(0, MAX_HISTORY_ITEMS);
    setVideoState(videoId, state);
    renderHistory(state.conversations);
  });
}

function deleteNoteForCurrentVideo(noteId) {
  getCurrentVideoId().then((videoId) => {
    if (!videoId) return;
    const state = getVideoState(videoId);
    state.notes = state.notes.filter((note) => note.id !== noteId);
    setVideoState(videoId, state);
    renderNotes(state.notes);
  });
}

function saveCurrentNote() {
  const notesText = noteInput.value.trim();
  if (!notesText) return;

  getCurrentVideoId().then((videoId) => {
    if (!videoId) {
      noteInput.value = '';
      return;
    }

    const state = getVideoState(videoId);
    const newNote = {
      id: `note-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: notesText,
      createdAt: new Date().toISOString(),
    };

    state.notes = [newNote, ...state.notes].slice(0, 8);
    setVideoState(videoId, state);
    renderNotes(state.notes);
    noteInput.value = '';
  });
}

function setStatus(online) {
  statusDot.style.background = online ? '#34d399' : '#f87171';
}

function parseTimeString(value) {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const rawParts = trimmed.split(':').map((part) => part.trim());
  if (!rawParts.length || rawParts.some((part) => part === '')) return null;

  const numbers = rawParts.map(Number);
  if (numbers.some((number) => Number.isNaN(number))) return null;

  if (numbers.length === 1) {
    return numbers[0];
  }

  if (numbers.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }

  if (numbers.length === 3) {
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  }

  return null;
}

function readSectionRange() {
  const startRaw = startTimeInput.value.trim();
  const endRaw = endTimeInput.value.trim();
  const start = startRaw ? Number(startRaw) : null;
  const end = endRaw ? Number(endRaw) : null;

  if (start !== null && Number.isNaN(start)) return {};
  if (end !== null && Number.isNaN(end)) return {};

  if (start !== null && end !== null && end < start) {
    return { start, end: start };
  }

  return {
    start: start !== null ? start : undefined,
    end: end !== null ? end : undefined,
  };
}

function renderSummary(data) {
  const overview = data?.overview || 'No overview available.';
  const keyTakeaways = Array.isArray(data?.key_takeaways) ? data.key_takeaways : [];
  const concepts = Array.isArray(data?.important_concepts) ? data.important_concepts : [];
  const detailed = data?.detailed_summary || overview;
  const timestamps = Array.isArray(data?.timestamps) ? data.timestamps : [];

  outputBox.hidden = false;
  answerText.innerHTML = `
    <div class="summary-box">
      <div class="summary-header">Overview</div>
      <div>${overview}</div>

      <div class="summary-header">Key takeaways</div>
      <ul>${keyTakeaways.map((item) => `<li>${item}</li>`).join('') || '<li>Not available.</li>'}</ul>

      <div class="summary-header">Important concepts</div>
      <ul>${concepts.map((item) => `<li>${item}</li>`).join('') || '<li>Not available.</li>'}</ul>

      <div class="summary-header">Detailed summary</div>
      <div>${detailed}</div>

      <div class="summary-header">Timestamps</div>
      <ul>${timestamps.map((item) => `<li data-time="${item.time || '00:00'}" class="timestamp-item"><strong>${item.time || '00:00'}</strong> — ${item.label || 'Key point'}</li>`).join('') || '<li>No timestamps found in the transcript.</li>'}</ul>
    </div>
  `;

  const timestampItems = answerText.querySelectorAll('.timestamp-item');
  timestampItems.forEach((item) => {
    item.addEventListener('click', () => {
      const seconds = parseTimeString(item.dataset.time || '0');
      if (seconds === null) return;
      startTimeInput.value = Math.max(0, Math.floor(seconds));
      endTimeInput.value = Math.max(Math.floor(seconds) + 30, Math.floor(seconds));
      questionInput.focus();
    });
  });

  answerText.classList.remove('error-text');
  sourcesEl.innerHTML = '<div class="source"><strong>Summary generated from the active video transcript.</strong></div>';
}

async function askQuestion() {
  const question = questionInput.value.trim();
  if (!question) {
    answerText.textContent = 'Please enter a question.';
    answerText.classList.add('error-text');
    outputBox.hidden = false;
    sourcesEl.innerHTML = '';
    return;
  }

  const videoId = await getCurrentVideoId();
  if (!videoId) {
    answerText.textContent = 'Open a YouTube video first so the extension can read its transcript.';
    answerText.classList.add('error-text');
    outputBox.hidden = false;
    sourcesEl.innerHTML = '';
    return;
  }

  addToHistory(question);

  outputBox.hidden = false;
  answerText.textContent = 'Loading...';
  answerText.classList.remove('error-text');
  sourcesEl.innerHTML = '';

  try {
    const section = readSectionRange();
    const body = {
      question,
      video_id: videoId,
      ...(Object.hasOwn(section, 'start') ? { start_time: section.start } : {}),
      ...(Object.hasOwn(section, 'end') ? { end_time: section.end } : {}),
    };

    const response = await fetch(buildApiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Request failed');
    }

    const data = await response.json();
    const finalAnswer = data.answer || 'Not mentioned in the transcript.';
    const finalSources = Array.isArray(data.sources) ? data.sources : [];
    answerText.textContent = finalAnswer;

    if (finalSources.length > 0) {
      sourcesEl.innerHTML = finalSources
        .map((source, index) => `<div class="source"><strong>Source ${index + 1}</strong><div>${source}</div></div>`)
        .join('');
    } else {
      sourcesEl.innerHTML = '<div class="source"><strong>No supporting evidence found.</strong></div>';
    }

    await addConversationEntry(question, finalAnswer, finalSources);
    setStatus(true);
  } catch (error) {
    const message = error && error.message && error.message.toLowerCase().includes('fetch')
      ? 'Could not reach the local backend. Start it with: .\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 from the backend folder.'
      : (error.message || 'Something went wrong.');

    answerText.textContent = message;
    answerText.classList.add('error-text');
    sourcesEl.innerHTML = '';
    setStatus(false);
  }
}

async function generateSummary() {
  const videoId = await getCurrentVideoId();
  if (!videoId) {
    answerText.textContent = 'Open a YouTube video first to generate a summary.';
    answerText.classList.add('error-text');
    outputBox.hidden = false;
    sourcesEl.innerHTML = '';
    return;
  }

  outputBox.hidden = false;
  answerText.textContent = 'Generating summary...';
  answerText.classList.remove('error-text');
  sourcesEl.innerHTML = '';

  try {
    const response = await fetch(buildApiUrl('/api/summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Summary request failed');
    }

    const data = await response.json();
    renderSummary(data);
    setStatus(true);
  } catch (error) {
    const message = error && error.message && error.message.toLowerCase().includes('fetch')
      ? 'Could not reach the local backend. Start it with: .\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 from the backend folder.'
      : (error.message || 'Summary failed.');

    answerText.textContent = message;
    answerText.classList.add('error-text');
    sourcesEl.innerHTML = '';
    setStatus(false);
  }
}

askBtn.addEventListener('click', askQuestion);
summaryBtn.addEventListener('click', generateSummary);
questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    askQuestion();
  }
});
apiUrlInput.addEventListener('change', () => {
  saveApiBaseUrl(apiUrlInput.value);
});
saveNoteBtn.addEventListener('click', saveCurrentNote);

if (apiUrlInput) {
  apiUrlInput.value = loadApiBaseUrl();
}

loadCurrentVideoHistory();
setStatus(true);
