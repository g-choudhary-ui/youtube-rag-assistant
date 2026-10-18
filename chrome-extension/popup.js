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
      let tab = tabs && tabs[0];
      const matchUrl = (url) => {
        if (!url) return null;
        const m = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^?#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      };

      const directId = matchUrl(tab?.url);
      if (directId) {
        resolve(directId);
        return;
      }

      // Fallback: search across all windows for a YouTube watch tab
      chrome.tabs.query({ url: '*://*.youtube.com/watch*' }, (ytTabs) => {
        const activeYt = ytTabs?.find((t) => t.active) || ytTabs?.[0];
        resolve(matchUrl(activeYt?.url));
      });
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

// Injected into YouTube tab to extract captions using multiple strategies
async function extractTranscriptFromPageContext() {
  try {
    // Helper function to read transcript segments from the DOM
    function readDomSegments() {
      const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
      if (!segs || segs.length === 0) return null;
      const items = [];
      segs.forEach((seg) => {
        const timeEl = seg.querySelector('.segment-timestamp') || seg.querySelector('[class*="timestamp"]');
        const textEl = seg.querySelector('.segment-text') || seg.querySelector('.yt-formatted-string') || seg.querySelector('[class*="text"]');
        const text = (textEl ? textEl.textContent : '').trim();
        if (text) {
          const timeStr = timeEl ? timeEl.textContent.trim() : '0:00';
          const parts = timeStr.split(':').map(Number);
          let sec = 0;
          if (parts.length === 2) sec = parts[0] * 60 + parts[1];
          else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
          items.push({ start: sec, duration: 2.0, text });
        }
      });
      return items.length > 0 ? JSON.stringify({
        events: items.map((it) => ({
          tStartMs: it.start * 1000,
          dDurationMs: it.duration * 1000,
          segs: [{ utf8: it.text }],
        })),
      }) : null;
    }

    // --- Strategy 1: Check if transcript panel is ALREADY open in the DOM ---
    const existing = readDomSegments();
    if (existing) return existing;

    // --- Strategy 2: Programmatically trigger "Show transcript" in YouTube DOM ---
    try {
      // 1. Expand video description if collapsed
      const expandBtn = document.querySelector('ytd-text-inline-expander #expand')
        || document.querySelector('#expand-button')
        || document.querySelector('#description-inline-expander #expand')
        || document.querySelector('tp-yt-paper-button#expand')
        || document.querySelector('#expand');
      if (expandBtn && expandBtn.offsetParent !== null) {
        expandBtn.click();
      }

      // 2. Locate and click the "Show transcript" button
      let transcriptBtn = document.querySelector('ytd-video-description-transcript-section-renderer button')
        || document.querySelector('ytd-video-description-transcript-section-renderer yt-button-shape button')
        || document.querySelector('button[aria-label*="transcript" i]')
        || document.querySelector('button[aria-label*="Transcript" i]');

      if (!transcriptBtn) {
        const allBtns = Array.from(document.querySelectorAll('button, yt-button-shape'));
        transcriptBtn = allBtns.find((b) => (b.textContent || '').toLowerCase().includes('transcript'));
      }

      if (transcriptBtn) {
        transcriptBtn.click();
        // Poll every 100ms up to 2.5 seconds for transcript segments to render
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const triggered = readDomSegments();
          if (triggered) return triggered;
        }
      }
    } catch (e) {
      console.warn('DOM transcript button trigger error:', e);
    }

    // --- Strategy 3: Innertube get_transcript in authenticated page context ---
    try {
      const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY');
      const context = window.ytcfg?.get?.('INNERTUBE_CONTEXT');

      let params = null;
      function findParams(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || params || depth > 8) return;
        if (obj.getTranscriptEndpoint?.params) {
          params = obj.getTranscriptEndpoint.params;
          return;
        }
        for (const k of Object.keys(obj)) {
          findParams(obj[k], depth + 1);
        }
      }
      if (window.ytInitialData) {
        findParams(window.ytInitialData);
      }

      if (apiKey && context && params) {
        const res = await fetch(`/youtubei/v1/get_transcript?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context, params }),
        });
        if (res.ok) {
          const data = await res.json();
          const actions = data?.actions || [];
          const items = [];
          for (const a of actions) {
            const segs = a?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
            if (Array.isArray(segs)) {
              for (const s of segs) {
                const r = s.transcriptSegmentRenderer;
                if (r) {
                  const start = parseInt(r.startMs || '0', 10) / 1000.0;
                  const text = (r.snippet?.runs || []).map((x) => x.text || '').join('').trim();
                  if (text) {
                    items.push({ start, duration: 2.0, text });
                  }
                }
              }
            }
          }
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
      }
    } catch (e) {
      console.warn('Innertube get_transcript error:', e);
    }

    // --- Strategy 4: Player response captionTracks ---
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

    let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (tracks && tracks.length) {
      const track = tracks.find((t) => (t.languageCode || '').startsWith('en'))
                 || tracks.find((t) => (t.languageCode || '').startsWith('hi'))
                 || tracks[0];

      if (track && track.baseUrl) {
        try {
          const res = await fetch(track.baseUrl);
          if (res.ok) {
            const body = await res.text();
            if (body && body.trim().length > 0) {
              return body;
            }
          }
        } catch (e) {}

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

    return null;
  } catch (err) {
    return null;
  }
}

async function fetchTranscriptFromActiveTab(videoId) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = tabs && tabs[0];

    // If active tab is not YouTube watch page, query YouTube watch tabs directly
    if (!tab?.url || !tab.url.includes('youtube.com/watch')) {
      const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
      tab = ytTabs?.find((t) => t.active) || ytTabs?.[0] || tab;
    }

    let rawPayload = null;

    // Strategy 1: Execute in MAIN world (has access to YouTube's player & session)
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
        throw new Error("Could not extract transcript automatically. On the YouTube page, please click '...more' in the video description and click 'Show transcript', then click Ask again.");
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
        throw new Error("Could not extract transcript automatically. On the YouTube page, please click '...more' in the video description and click 'Show transcript', then click One-click Summary again.");
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
