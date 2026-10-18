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
const DEFAULT_API_BASE_URL = 'https://youtube-rag-assistant-1-hjvt.onrender.com';
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

function decodeHtmlEntities(str) {
  if (!str) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

function parseTranscriptPayload(rawText) {
  if (!rawText || !rawText.trim()) return [];

  const trimmed = rawText.trim();

  // 1. Check if JSON format (fmt=json3)
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const events = Array.isArray(data.events) ? data.events : [];
      const snippets = [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s) => s.utf8 || '').join('').trim();
        if (text && text !== '\n') {
          const start = (ev.tStartMs || 0) / 1000.0;
          const dur = (ev.dDurationMs || 0) / 1000.0;
          snippets.push({ start, duration: dur, text: decodeHtmlEntities(text) });
        }
      }
      if (snippets.length > 0) return snippets;
    } catch (e) {}
  }

  // 2. Parse XML format (<transcript><text start="..." dur="...">...</text></transcript>)
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(rawText, 'text/xml');
    const nodes = xmlDoc.getElementsByTagName('text');
    const snippets = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const start = parseFloat(node.getAttribute('start') || '0');
      const dur = parseFloat(node.getAttribute('dur') || '0');
      const text = decodeHtmlEntities(node.textContent || '').trim();
      if (text) {
        snippets.push({ start, duration: dur, text });
      }
    }
    return snippets;
  } catch (e) {
    console.warn('Failed to parse transcript XML:', e);
    return [];
  }
}

// Injected into YouTube tab to fetch captions directly within YouTube's origin and session
async function extractTranscriptFromPageContext() {
  try {
    // 1. Get player response object (movie_player has freshest data across SPA navigations)
    let playerResponse = null;
    const playerEl = document.getElementById('movie_player');
    if (playerEl && typeof playerEl.getPlayerResponse === 'function') {
      try {
        playerResponse = playerEl.getPlayerResponse();
      } catch (e) {}
    }
    if (!playerResponse && window.ytInitialPlayerResponse) {
      playerResponse = window.ytInitialPlayerResponse;
    }

    // 2. Extract caption tracks
    let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    // 3. Fallback: search script tags with balanced bracket matching
    if (!tracks || !tracks.length) {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        const marker = '"captionTracks":';
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          const start = text.indexOf('[', idx);
          if (start !== -1) {
            let depth = 0;
            let inStr = false;
            let esc = false;
            for (let i = start; i < text.length; i++) {
              const c = text[i];
              if (esc) { esc = false; continue; }
              if (c === '\\') { esc = true; continue; }
              if (c === '"') { inStr = !inStr; continue; }
              if (!inStr) {
                if (c === '[') depth++;
                else if (c === ']') {
                  depth--;
                  if (depth === 0) {
                    try {
                      tracks = JSON.parse(text.substring(start, i + 1));
                    } catch (e) {}
                    break;
                  }
                }
              }
            }
          }
        }
        if (tracks && tracks.length) break;
      }
    }

    // 4. If caption tracks found, fetch the timedtext data inside the page
    if (tracks && tracks.length) {
      const track = tracks.find((t) => (t.languageCode || '').startsWith('en'))
                 || tracks.find((t) => (t.languageCode || '').startsWith('hi'))
                 || tracks[0];

      if (track && track.baseUrl) {
        // Try standard timedtext fetch (same-origin, includes cookies)
        try {
          const res = await fetch(track.baseUrl);
          if (res.ok) {
            const body = await res.text();
            if (body && body.trim().length > 0) {
              return body;
            }
          }
        } catch (e) {}

        // Fallback: try with &fmt=json3
        try {
          const jsonUrl = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
          const res2 = await fetch(jsonUrl);
          if (res2.ok) {
            const body2 = await res2.text();
            if (body2 && body2.trim().length > 0) {
              return body2;
            }
          }
        } catch (e) {}
      }
    }

    // 5. Fallback: check if the YouTube transcript panel is open in the DOM
    const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (segs && segs.length > 0) {
      const items = [];
      segs.forEach((seg) => {
        const timeEl = seg.querySelector('.segment-timestamp');
        const textEl = seg.querySelector('.segment-text');
        if (textEl && textEl.textContent.trim()) {
          const timeStr = timeEl ? timeEl.textContent.trim() : '0:00';
          const parts = timeStr.split(':').map(Number);
          let sec = 0;
          if (parts.length === 2) sec = parts[0] * 60 + parts[1];
          else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
          items.push({ start: sec, duration: 2.0, text: textEl.textContent.trim() });
        }
      });
      if (items.length > 0) {
        return JSON.stringify({
          events: items.map((it) => ({
            tStartMs: it.start * 1000,
            dDurationMs: it.duration * 1000,
            segs: [{ utf8: it.text }],
          })),
        });
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

async function fetchTranscriptFromActiveTab(videoId) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

    let rawPayload = null;

    // Strategy 1: Execute in MAIN world (access to movie_player & window.ytInitialPlayerResponse)
    if (tab && tab.id) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: extractTranscriptFromPageContext,
        });
        rawPayload = results?.[0]?.result;
      } catch (err) {
        console.warn('executeScript in MAIN world failed, trying isolated world:', err);
      }
    }

    // Strategy 2: Execute in ISOLATED world (fallback if MAIN world is restricted)
    if (!rawPayload && tab && tab.id) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractTranscriptFromPageContext,
        });
        rawPayload = results?.[0]?.result;
      } catch (err) {
        console.warn('executeScript in isolated world failed:', err);
      }
    }

    // Strategy 3: Direct fetch from extension if scripting failed
    if (!rawPayload && videoId) {
      try {
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        if (pageRes.ok) {
          const html = await pageRes.text();
          const marker = '"captionTracks":';
          const idx = html.indexOf(marker);
          if (idx !== -1) {
            const start = html.indexOf('[', idx);
            if (start !== -1) {
              let depth = 0;
              let inStr = false;
              let esc = false;
              for (let i = start; i < html.length; i++) {
                const c = html[i];
                if (esc) { esc = false; continue; }
                if (c === '\\') { esc = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (!inStr) {
                  if (c === '[') depth++;
                  else if (c === ']') {
                    depth--;
                    if (depth === 0) {
                      try {
                        const tracks = JSON.parse(html.substring(start, i + 1));
                        const track = tracks.find((t) => (t.languageCode || '').startsWith('en'))
                                   || tracks.find((t) => (t.languageCode || '').startsWith('hi'))
                                   || tracks[0];
                        if (track && track.baseUrl) {
                          const capRes = await fetch(track.baseUrl);
                          if (capRes.ok) {
                            rawPayload = await capRes.text();
                          }
                        }
                      } catch (e) {}
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('Direct YouTube fetch fallback failed:', err);
      }
    }

    if (!rawPayload) return null;

    const snippets = parseTranscriptPayload(rawPayload);
    return snippets.length ? snippets : null;
  } catch (err) {
    console.warn('fetchTranscriptFromActiveTab error:', err);
    return null;
  }
}

async function askQuestion() {
  const question = questionInput.value.trim();
  if (!question) {
    answerText.textContent = 'Please enter a question about the video transcript.';
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
  answerText.textContent = 'Extracting transcript from YouTube tab...';
  answerText.classList.remove('error-text');
  sourcesEl.innerHTML = '';

  try {
    const section = readSectionRange();
    const snippets = await fetchTranscriptFromActiveTab(videoId);

    if (!snippets || snippets.length === 0) {
      const isCloudHost = !buildApiUrl('').includes('localhost') && !buildApiUrl('').includes('127.0.0.1');
      if (isCloudHost) {
        throw new Error('Could not extract transcript from this video. Please make sure subtitles/captions (CC) are available on this video and refresh the YouTube tab.');
      }
      answerText.textContent = '⚠️ Could not extract transcript client-side. Attempting server-side fetch...';
    } else {
      answerText.textContent = 'Searching transcript and generating answer...';
    }

    const body = {
      question,
      video_id: videoId,
      ...(snippets && snippets.length ? { transcript_snippets: snippets } : {}),
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
    const isNetworkError = error instanceof TypeError;
    const message = isNetworkError
      ? 'Could not reach backend URL. Please check your Backend URL field and your network connection.'
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
  answerText.textContent = 'Extracting transcript from YouTube tab...';
  answerText.classList.remove('error-text');
  sourcesEl.innerHTML = '';

  try {
    const snippets = await fetchTranscriptFromActiveTab(videoId);

    if (!snippets || snippets.length === 0) {
      const isCloudHost = !buildApiUrl('').includes('localhost') && !buildApiUrl('').includes('127.0.0.1');
      if (isCloudHost) {
        throw new Error('Could not extract transcript from this video. Please make sure subtitles/captions (CC) are available on this video and refresh the YouTube tab.');
      }
      answerText.textContent = '⚠️ Could not extract transcript client-side. Attempting server-side fetch...';
    } else {
      answerText.textContent = 'Reading transcript and generating summary...';
    }

    const response = await fetch(buildApiUrl('/api/summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: videoId,
        ...(snippets && snippets.length ? { transcript_snippets: snippets } : {}),
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Summary request failed');
    }

    const data = await response.json();
    renderSummary(data);
    setStatus(true);
  } catch (error) {
    const isNetworkError = error instanceof TypeError;
    const message = isNetworkError
      ? 'Could not reach backend URL. Please check your Backend URL field and your network connection.'
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
