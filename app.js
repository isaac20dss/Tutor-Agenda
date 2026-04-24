/* ============================================================
 * TutorAgenda — Application Logic
 * Vanilla JavaScript single-file SPA with localStorage persistence
 * ============================================================ */

(function () {
  'use strict';

  // =========================================================
  // STORAGE (Supabase with localStorage cache; realtime for multi-device sync)
  // =========================================================

  const STORAGE_KEY = 'tutoragenda_v1';

  const SUPABASE_URL = 'https://cajwkwbohetrjswwuevj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhandrd2JvaGV0cmpzd3d1ZXZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNjcyMzIsImV4cCI6MjA5MjY0MzIzMn0.OecbTIbyw4_giu0qi2Ca8v23-ZH-4OGC-Cscjcci_S0';

  let supabase = null;
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
    }
  } catch (e) {
    console.error('Supabase init failed', e);
    supabase = null;
  }

  let remoteLoaded = false;       // true once we've fetched the row from Supabase
  let realtimeChannel = null;     // active realtime subscription
  let saveTimer = null;           // debounce timer for remote upsert
  let lastSaveAt = 0;             // timestamp of last outgoing upsert (for realtime echo suppression)

  function uid(prefix = 'id') {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // =========================================================
  // DEFAULT STATE
  // =========================================================

  const DEFAULT_COLORS = [
    '#c6833a', '#2d7a6b', '#b8425c', '#3a5ea8', '#4a7c3b',
    '#8b5a9b', '#d4a017', '#a83a2e', '#4a6fa5', '#6b7a8f'
  ];

  function defaultState() {
    return {
      users: [
        { id: 'user_isaac', username: 'Isaac', password: 'Issac1542', email: '', phone: '', role: 'admin', createdAt: Date.now() }
      ],
      currentUserId: null,
      sessionActive: false,

      settings: {
        workStart: '08:00',
        workEnd: '22:00',
        lessonDuration: 60,
        packageSize: 4,
        packagePrice: 400,
        singleLessonPrice: 120,
        workDays: [1, 2, 3, 4, 5], // Mon-Fri
        holidays: [], // [{id, date, label}]
        breakEnabled: false,
        breakStart: '12:00',
        breakEnd: '13:00',
        whatsappReminderTemplate: 'Olá {aluno}! Passando para lembrar que amanhã ({data}) você tem aula de {horaInicio} às {horaFim} com {professor} na {sala}. Até lá! 📚',
        whatsappPackageEndTemplate: 'Olá {aluno}! Seu pacote está acabando — você tem {aulasRestantes} aula(s) restante(s). Que tal renovar para continuar evoluindo?',
        whatsappNoLessonsTemplate: 'Olá {aluno}! Seu pacote terminou. Vamos renovar para continuar suas aulas? Temos pacote de {pacotePadrao} aulas ou aulas avulsas. 📚',
        packageEndThreshold: 1,
        packageEndMode: 'available', // 'available' | 'remaining'
        theme: 'light',
        palette: 'parchment',
        fontFamily: 'default',
        shortcuts: {
          newLesson: 'n',
          search: 'Ctrl+k',
          prevPeriod: 'ArrowLeft',
          nextPeriod: 'ArrowRight',
          closeModal: 'Escape',
          goDashboard: 'g d',
          goCalendar: 'g c',
          goStudents: 'g a',
          toggleTheme: 't',
          toggleZoom: 'l'
        },
        brand: {
          name: 'TutorAgenda',
          primaryColor: '#c6833a',
          logoDataUrl: null
        }
      },

      rooms: [
        { id: 'room_1', name: 'Sala Azul', capacity: 4, description: 'Sala ampla com quadro', color: '#3a5ea8', active: true }
      ],

      teachers: [
        { id: 'teacher_1', name: 'Ana Clara', phone: '(48) 99999-0001', email: 'ana@example.com', address: '', specialty: 'Matemática', color: '#2d7a6b', hourlyRate: 60, paymentMethod: 'PIX', pixKey: 'ana@example.com', paymentNotes: '', active: true }
      ],

      students: [
        {
          id: 'student_1',
          name: 'Pedro Silva',
          phone: '(48) 99999-1234',
          email: 'pedro@example.com',
          address: '',
          guardianName: 'Maria Silva',
          guardianPhone: '(48) 99999-5678',
          guardianIsFinancial: true,
          active: true,
          favorite: false,
          customPricing: false,
          packagePrice: null,
          singleLessonPrice: null,
          packageSize: 4,
          lessonsCompleted: 1,
          group: null,
          createdAt: Date.now()
        }
      ],

      groups: [], // [{id, name, studentIds}]

      lessons: [], // [{id, roomId, teacherIds[], studentIds[], date, start, end, status, modality, packageGroupId, notes, cancelReason, needsReplacement, replacementOf, totalPrice, pricePerStudent, individualPrices, createdAt}]

      blocks: [], // room blockers: [{id, roomId, date, start, end, label}]

      notifications: [], // [{id, type, title, desc, time, read}]

      messageLog: [], // [{id, studentId, lessonId, channel, text, sentAt}]

      payments: [], // [{id, studentId, description, amount, dueDate, status: 'pending'|'paid'|'overdue', type: 'package'|'single'|'custom', lessonCount, paidAt, createdAt}]

      notes: [], // [{id, title, content, type: 'note'|'table', tableRows[], tableCols[], status, statusColor, categoryId, createdAt, updatedAt}]
      noteCategories: [], // [{id, name, color}]

      schemaVersion: 1
    };
  }

  // =========================================================
  // STATE MANAGEMENT
  // =========================================================

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      // Merge with defaults to ensure all fields exist (schema migration)
      const def = defaultState();
      const merged = { ...def, ...parsed };
      merged.settings = { ...def.settings, ...(parsed.settings || {}) };
      merged.settings.brand = { ...def.settings.brand, ...((parsed.settings || {}).brand || {}) };
      merged.settings.shortcuts = { ...def.settings.shortcuts, ...((parsed.settings || {}).shortcuts || {}) };
      return merged;
    } catch (e) {
      console.error('Failed to load state', e);
      return defaultState();
    }
  }

  function saveState(silent = false) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (!silent && broadcastChannel) {
        broadcastChannel.postMessage({ type: 'sync', timestamp: Date.now() });
      }
    } catch (e) {
      console.error('Failed to save state', e);
      showError('Erro ao salvar', 'Não foi possível salvar os dados localmente. Verifique o espaço disponível.');
    }
  }

  if (broadcastChannel) {
    broadcastChannel.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'sync') {
        state = loadState();
        rerender();
      }
    });
  }

  // Also sync across tabs via storage event fallback
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      state = loadState();
      rerender();
    }
  });

  // =========================================================
  // UTILITIES
  // =========================================================

  function $(selector, root = document) { return root.querySelector(selector); }
  function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatCurrency(value) {
    const v = Number(value) || 0;
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatDate(dateStr, opts = {}) {
    if (!dateStr) return '';
    const d = parseDate(dateStr);
    if (!d) return '';
    return d.toLocaleDateString('pt-BR', opts);
  }

  function parseDate(str) {
    // YYYY-MM-DD
    if (!str) return null;
    const parts = String(str).split('-');
    if (parts.length !== 3) return null;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  function dateToString(d) {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function todayStr() {
    return dateToString(new Date());
  }

  function timeToMinutes(t) {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  function minutesToTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function addDays(dateStr, n) {
    const d = parseDate(dateStr);
    if (!d) return dateStr;
    d.setDate(d.getDate() + n);
    return dateToString(d);
  }

  function startOfWeek(dateStr) {
    const d = parseDate(dateStr) || new Date();
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day);
    return dateToString(d);
  }

  function dowLabel(dayIdx, short = true) {
    const labels = short
      ? ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
      : ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    return labels[dayIdx] || '';
  }

  function monthLabel(monthIdx) {
    const labels = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    return labels[monthIdx] || '';
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function icon(id, size = 16, extra = '') {
    return `<svg width="${size}" height="${size}" aria-hidden="true" ${extra ? `class="${extra}"` : ''}><use href="#i-${id}"/></svg>`;
  }

  function isHoliday(dateStr) {
    return state.settings.holidays.some(h => h.date === dateStr);
  }

  function isWorkDay(dateStr) {
    const d = parseDate(dateStr);
    if (!d) return false;
    if (isHoliday(dateStr)) return false;
    return state.settings.workDays.includes(d.getDay());
  }

  function getStudentLessonStatus(student) {
    // Base: manual lessonsCompleted + done lessons (computed)
    const manualCompleted = Number(student.lessonsCompleted) || 0;
    const scheduledCount = state.lessons.filter(l =>
      l.studentIds.includes(student.id) &&
      l.status === 'scheduled' &&
      !l.isReplacement
    ).length;
    // Allow 0 (student without contracted lessons). Use ?? to respect explicit 0.
    const total = (student.packageSize ?? null) !== null ? Number(student.packageSize) : (state.settings.packageSize || 0);
    const used = manualCompleted;
    // "remaining" = what's left IN THE PACKAGE (available to schedule)
    // "available" = what can still be scheduled (remaining - already scheduled)
    const remaining = Math.max(0, total - used);
    const available = Math.max(0, total - used - scheduledCount);
    const pct = total > 0 ? used / total : (used > 0 ? 1 : 0);
    let color = 'ok';
    if (total === 0) color = 'neutral';
    else if (pct >= 1) color = 'danger';
    else if (pct >= 0.5) color = 'warn';
    return { used, remaining, available, scheduled: scheduledCount, total, color, pct };
  }

  function getStudentPricing(student) {
    if (student && student.customPricing) {
      return {
        packagePrice: student.packagePrice ?? state.settings.packagePrice,
        singleLessonPrice: student.singleLessonPrice ?? state.settings.singleLessonPrice
      };
    }
    return {
      packagePrice: state.settings.packagePrice,
      singleLessonPrice: state.settings.singleLessonPrice
    };
  }

  function findById(collection, id) {
    return (state[collection] || []).find(x => x.id === id);
  }

  // =========================================================
  // ROUTING / VIEW STATE
  // =========================================================

  const appView = {
    route: 'dashboard',
    calendarDate: todayStr(),
    calendarZoom: 'week', // 'day' | 'week' | 'month' | 'timeline'
    calendarInterval: 60, // minutes per row (for detail: 15, 30, 60)
    calendarFilterRoom: null,
    calendarFilterTeacher: null,
    viewModes: {
      rooms: 'grid', teachers: 'grid', students: 'grid'
    },
    filters: {
      students: { status: 'all', favorite: false, search: '' },
      teachers: { status: 'all', search: '' },
      rooms: { status: 'all', search: '' },
      notes: { categoryId: 'all', status: 'all', search: '' }
    },
    modalStack: [],
    notificationsOpen: false,
    sidebarOpen: false,
    zoomMode: false,
    zoomScale: 1,
    zoomPanX: 0,
    zoomPanY: 0,
    financialTab: 'all'
  };

  // =========================================================
  // NOTIFICATIONS
  // =========================================================

  function toast(type, title, desc, timeout = 4000) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const iconId = type === 'ok' ? 'check' : type === 'danger' ? 'alert' : type === 'warn' ? 'alert' : 'info';
    t.innerHTML = `
      <div class="toast-icon">${icon(iconId, 16)}</div>
      <div class="toast-body">
        <div class="title">${escapeHtml(title)}</div>
        ${desc ? `<div class="desc">${escapeHtml(desc)}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Fechar">${icon('close', 14)}</button>
    `;
    stack.appendChild(t);
    t.querySelector('.toast-close').addEventListener('click', () => t.remove());
    if (timeout) setTimeout(() => { if (t.parentNode) t.remove(); }, timeout);
  }

  function pushNotification(type, title, desc) {
    state.notifications.unshift({
      id: uid('notif'),
      type, title, desc,
      time: Date.now(),
      read: false
    });
    if (state.notifications.length > 50) state.notifications.length = 50;
    saveState();
  }

  // =========================================================
  // ERROR & CONFIRM MODALS
  // =========================================================

  /**
   * Attach HTML5 drag-and-drop sorting to children matching a selector.
   * Calls onReorder(fromId, toId) when a drop happens — the caller mutates the array.
   */
  function attachSortable(containerEl, itemSelector, idAttr, onReorder) {
    let draggedId = null;
    containerEl.querySelectorAll(itemSelector).forEach(item => {
      item.addEventListener('dragstart', (e) => {
        draggedId = item.getAttribute(idAttr);
        item.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) {}
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '';
        containerEl.querySelectorAll(itemSelector).forEach(el => el.style.borderTop = el.style.borderLeft = '');
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const toId = item.getAttribute(idAttr);
        if (!draggedId || draggedId === toId) return;
        onReorder(draggedId, toId);
        draggedId = null;
      });
    });
  }

  // =========================================================
  // CONTEXT MENU (right-click actions)
  // =========================================================

  /**
   * Show a context menu at (x, y) with the given items.
   * items: [{ label, icon?, onClick, danger?, disabled?, divider? }]
   * Closes on outside click, Escape, scroll, or resize.
   */
  // =========================================================
  // LESSON HOVER CARD — small popover with lesson details on hover
  // =========================================================

  let hoverCardTimer = null;
  let hoverCardEl = null;
  const HOVER_DELAY = 450; // ms — matches Figma/Notion feel
  const HOVER_OFFSET = 12; // px — distance from cursor

  function closeLessonHoverCard() {
    if (hoverCardTimer) { clearTimeout(hoverCardTimer); hoverCardTimer = null; }
    if (hoverCardEl) { hoverCardEl.remove(); hoverCardEl = null; }
  }

  function buildLessonHoverContent(lesson) {
    const room = findById('rooms', lesson.roomId);
    const teachers = lesson.teacherIds.map(id => findById('teachers', id)).filter(Boolean);
    const students = lesson.studentIds.map(id => findById('students', id)).filter(Boolean);
    const color = room?.color || '#c6833a';

    let statusBadge = '';
    if (lesson.status === 'done') statusBadge = '<span class="hover-card-badge" style="background:var(--ok-soft);color:var(--ok-ink)">Concluída</span>';
    else if (lesson.status === 'canceled') statusBadge = `<span class="hover-card-badge" style="background:var(--danger-soft);color:var(--danger-ink)">${lesson.needsReplacement ? 'Remarcar' : 'Cancelada'}</span>`;
    else statusBadge = '<span class="hover-card-badge" style="background:var(--info-soft);color:var(--info-ink)">Agendada</span>';

    const modalityLabel = lesson.modality === 'single' ? 'Avulsa' : lesson.modality === 'package' ? 'Pacote' : lesson.modality === 'other' ? 'Outros' : '';

    return `
      <div class="hover-card-accent" style="background:${color}"></div>
      <div class="hover-card-body">
        <div class="hover-card-header">
          <div>
            <div class="hover-card-time">${lesson.start} — ${lesson.end}</div>
            <div class="hover-card-date">${formatDate(lesson.date, { weekday: 'short', day: '2-digit', month: 'short' })}</div>
          </div>
          ${statusBadge}
        </div>

        ${students.length > 0 ? `
          <div class="hover-card-row">
            <span class="hover-card-label">${students.length === 1 ? 'Aluno' : 'Alunos'}</span>
            <div class="hover-card-value">
              ${students.slice(0, 3).map(s => `<span class="hover-card-chip"><span class="hover-card-dot" style="background:${s.color || '#c6833a'}"></span>${escapeHtml(s.name)}</span>`).join('')}
              ${students.length > 3 ? `<span class="text-xs text-muted">+${students.length - 3}</span>` : ''}
            </div>
          </div>
        ` : ''}

        ${teachers.length > 0 ? `
          <div class="hover-card-row">
            <span class="hover-card-label">${teachers.length === 1 ? 'Professor' : 'Professores'}</span>
            <div class="hover-card-value">${teachers.map(t => escapeHtml(t.name)).join(', ')}</div>
          </div>
        ` : ''}

        <div class="hover-card-row">
          <span class="hover-card-label">Sala</span>
          <div class="hover-card-value">
            <span class="hover-card-chip"><span class="hover-card-dot" style="background:${color}"></span>${escapeHtml(room?.name || '—')}</span>
          </div>
        </div>

        ${modalityLabel ? `
          <div class="hover-card-row">
            <span class="hover-card-label">Tipo</span>
            <div class="hover-card-value text-muted text-xs">${modalityLabel}</div>
          </div>
        ` : ''}

        ${lesson.notes ? `
          <div class="hover-card-notes">${escapeHtml(lesson.notes.slice(0, 100))}${lesson.notes.length > 100 ? '…' : ''}</div>
        ` : ''}

        ${lesson.status === 'canceled' && lesson.cancelReason ? `
          <div class="hover-card-notes text-xs" style="color:var(--danger-ink)">Motivo: ${escapeHtml(lesson.cancelReason)}</div>
        ` : ''}
      </div>
    `;
  }

  function positionHoverCard(el, anchorRect, mouseX, mouseY) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = el.offsetWidth;
    const cardH = el.offsetHeight;

    // Prefer: to the right of the anchor, aligned with cursor Y
    let left = anchorRect.right + HOVER_OFFSET;
    let top = mouseY - cardH / 2;

    // If overflows right, place to the left
    if (left + cardW > vw - 8) left = anchorRect.left - cardW - HOVER_OFFSET;
    // If still out, clamp to screen
    if (left < 8) left = 8;
    if (left + cardW > vw - 8) left = vw - cardW - 8;

    // Vertical clamp
    if (top < 8) top = 8;
    if (top + cardH > vh - 8) top = vh - cardH - 8;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function openLessonHoverCard(lessonEl, lessonId, mouseX, mouseY) {
    closeLessonHoverCard();
    const lesson = state.lessons.find(l => l.id === lessonId);
    if (!lesson) return;

    hoverCardEl = document.createElement('div');
    hoverCardEl.className = 'lesson-hover-card';
    hoverCardEl.setAttribute('role', 'tooltip');
    hoverCardEl.innerHTML = buildLessonHoverContent(lesson);
    document.body.appendChild(hoverCardEl);

    const rect = lessonEl.getBoundingClientRect();
    positionHoverCard(hoverCardEl, rect, mouseX, mouseY);

    // Keep card alive while mouse is over it (so user can read links etc)
    hoverCardEl.addEventListener('mouseenter', () => {
      if (hoverCardTimer) { clearTimeout(hoverCardTimer); hoverCardTimer = null; }
    });
    hoverCardEl.addEventListener('mouseleave', closeLessonHoverCard);
  }

  function attachLessonHoverCards(scopeEl) {
    const scope = scopeEl || document;
    scope.querySelectorAll('[data-lesson-id]').forEach(el => {
      // Avoid duplicate binding
      if (el._hoverBound) return;
      el._hoverBound = true;

      let lastMouseX = 0, lastMouseY = 0;
      el.addEventListener('mouseenter', (e) => {
        // Don't show while dragging or in zoom-mode pan
        if (document.body.classList.contains('dragging-lesson')) return;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (hoverCardTimer) clearTimeout(hoverCardTimer);
        hoverCardTimer = setTimeout(() => {
          openLessonHoverCard(el, el.dataset.lessonId, lastMouseX, lastMouseY);
        }, HOVER_DELAY);
      });
      el.addEventListener('mousemove', (e) => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      });
      el.addEventListener('mouseleave', closeLessonHoverCard);
      // Close on any mouse action (click, drag start)
      el.addEventListener('mousedown', closeLessonHoverCard);
    });
  }

  function showContextMenu(x, y, items) {
    // Remove any open menu first
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((it, i) => {
      if (it.divider) return `<div class="context-menu-divider"></div>`;
      const cls = ['context-menu-item'];
      if (it.danger) cls.push('danger');
      if (it.disabled) cls.push('disabled');
      return `
        <div class="${cls.join(' ')}" data-ctx-idx="${i}" role="menuitem">
          ${it.icon ? icon(it.icon, 14) : '<span style="width:14px;display:inline-block"></span>'}
          <span>${escapeHtml(it.label)}</span>
          ${it.shortcut ? `<kbd>${escapeHtml(it.shortcut)}</kbd>` : ''}
        </div>
      `;
    }).join('');
    document.body.appendChild(menu);

    // Position — flip if it would overflow the viewport
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let finalX = x;
    let finalY = y;
    if (x + rect.width > vw - 8) finalX = Math.max(8, vw - rect.width - 8);
    if (y + rect.height > vh - 8) finalY = Math.max(8, vh - rect.height - 8);
    menu.style.left = `${finalX}px`;
    menu.style.top = `${finalY}px`;

    const close = () => {
      menu.remove();
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('contextmenu', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
    const onOutside = (ev) => {
      if (!menu.contains(ev.target)) close();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    };

    // Item handlers
    menu.querySelectorAll('[data-ctx-idx]').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = parseInt(el.dataset.ctxIdx, 10);
        const item = items[idx];
        if (!item || item.disabled) return;
        close();
        try { item.onClick && item.onClick(); } catch (e) { console.error(e); }
      });
    });

    // Defer attaching outside-click so it doesn't catch the original event
    setTimeout(() => {
      document.addEventListener('click', onOutside, true);
      document.addEventListener('contextmenu', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    }, 0);

    return { close };
  }

  /**
   * Helper to attach a contextmenu listener to all elements matching a selector.
   * resolver(target) should return the array of menu items or null to skip.
   */
  function bindContextMenu(rootEl, selector, resolver) {
    const scope = rootEl || document;
    scope.querySelectorAll(selector).forEach(el => {
      el.addEventListener('contextmenu', (e) => {
        const items = resolver(el, e);
        if (!items || items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
  }

  function showError(title, description) {
    const mount = document.getElementById('modal-mount');
    const node = document.createElement('div');
    node.className = 'modal-backdrop';
    node.innerHTML = `
      <div class="modal modal-sm modal-error" role="alertdialog" aria-labelledby="err-title">
        <div class="modal-header">
          <div class="error-icon">${icon('alert', 18)}</div>
          <div style="flex:1">
            <h3 id="err-title">${escapeHtml(title)}</h3>
          </div>
          <button class="modal-close" aria-label="Fechar">${icon('close', 18)}</button>
        </div>
        <div class="modal-body">
          <p style="margin:0">${escapeHtml(description)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" data-action="close">Entendi</button>
        </div>
      </div>
    `;
    mount.appendChild(node);
    const close = () => node.remove();
    node.querySelector('.modal-close').addEventListener('click', close);
    node.querySelector('[data-action="close"]').addEventListener('click', close);
  }

  function showConfirm(title, description, onConfirm, confirmLabel = 'Confirmar', confirmStyle = 'primary') {
    const mount = document.getElementById('modal-mount');
    const node = document.createElement('div');
    node.className = 'modal-backdrop';
    const btnClass = confirmStyle === 'danger' ? 'btn-danger' : 'btn-primary';
    node.innerHTML = `
      <div class="modal modal-sm" role="alertdialog">
        <div class="modal-header">
          <div class="confirm-icon">${icon('alert', 18)}</div>
          <div style="flex:1">
            <h3>${escapeHtml(title)}</h3>
          </div>
          <button class="modal-close" aria-label="Fechar">${icon('close', 18)}</button>
        </div>
        <div class="modal-body"><p style="margin:0">${escapeHtml(description)}</p></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
          <button class="btn ${btnClass}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    mount.appendChild(node);
    const close = () => node.remove();
    node.querySelector('.modal-close').addEventListener('click', close);
    node.querySelector('[data-action="cancel"]').addEventListener('click', close);
    node.querySelector('[data-action="confirm"]').addEventListener('click', () => { close(); onConfirm(); });
  }

  // =========================================================
  // GENERIC MODAL
  // =========================================================

  function openModal(html, { size = 'md', onMount, onClose } = {}) {
    // Close any open lesson hover card when opening a modal
    if (typeof closeLessonHoverCard === 'function') closeLessonHoverCard();
    const mount = document.getElementById('modal-mount');
    const node = document.createElement('div');
    node.className = 'modal-backdrop';
    const sizeClass = size === 'lg' ? 'modal-lg' : size === 'sm' ? 'modal-sm' : '';
    node.innerHTML = `<div class="modal ${sizeClass}">${html}</div>`;
    mount.appendChild(node);
    const close = () => {
      if (onClose) onClose();
      node.remove();
    };
    // Track where mousedown started. Only close on backdrop if the whole
    // click (down AND up) happens on the backdrop — prevents closing when
    // user selects text inside modal and releases outside.
    let mouseDownOnBackdrop = false;
    node.addEventListener('mousedown', (e) => {
      mouseDownOnBackdrop = (e.target === node);
    });
    node.addEventListener('mouseup', (e) => {
      // Don't auto-close from backdrop click — require explicit button/X
      mouseDownOnBackdrop = false;
    });
    const closers = node.querySelectorAll('[data-close-modal]');
    closers.forEach(b => b.addEventListener('click', close));
    if (onMount) onMount(node, close);
    return { node, close };
  }

  // =========================================================
  // CONFLICT DETECTION
  // =========================================================

  function hasTimeConflict(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * Check if a lesson would conflict.
   * Returns null if ok, or {message} if conflict.
   */
  function checkLessonConflict({ roomId, teacherIds, studentIds, date, start, end, excludeLessonId }) {
    const sMin = timeToMinutes(start);
    const eMin = timeToMinutes(end);

    // Holiday check
    if (isHoliday(date)) {
      const h = state.settings.holidays.find(hh => hh.date === date);
      return { message: `A data ${formatDate(date)} é um feriado (${h.label}). Os agendamentos estão bloqueados.` };
    }

    // Work hours validation
    const workStart = timeToMinutes(state.settings.workStart);
    const workEnd = timeToMinutes(state.settings.workEnd);
    if (sMin < workStart || eMin > workEnd) {
      return { message: `Fora do horário de expediente. O sistema aceita apenas agendamentos entre ${state.settings.workStart} e ${state.settings.workEnd}. Ajuste o horário ou altere o expediente nas configurações.` };
    }

    // Break/interval validation
    if (state.settings.breakEnabled) {
      const breakStart = timeToMinutes(state.settings.breakStart);
      const breakEnd = timeToMinutes(state.settings.breakEnd);
      if (breakStart < breakEnd && hasTimeConflict(sMin, eMin, breakStart, breakEnd)) {
        return { message: `O horário conflita com o intervalo configurado (${state.settings.breakStart} — ${state.settings.breakEnd}). Ajuste o horário ou desative o intervalo nas configurações.` };
      }
    }

    // Block conflicts in same room
    const blockConflicts = state.blocks.filter(b =>
      b.roomId === roomId &&
      b.date === date &&
      hasTimeConflict(sMin, eMin, timeToMinutes(b.start), timeToMinutes(b.end))
    );
    if (blockConflicts.length) {
      return { message: `Conflito com bloqueio "${blockConflicts[0].label}" em ${formatDate(date)} das ${blockConflicts[0].start} às ${blockConflicts[0].end}.` };
    }

    // Room conflicts
    const roomConflicts = state.lessons.filter(l =>
      l.id !== excludeLessonId &&
      l.roomId === roomId &&
      l.date === date &&
      l.status !== 'canceled' &&
      hasTimeConflict(sMin, eMin, timeToMinutes(l.start), timeToMinutes(l.end))
    );
    if (roomConflicts.length) {
      const room = findById('rooms', roomId);
      return { message: `A sala "${room?.name}" já tem uma aula em ${formatDate(date)} das ${roomConflicts[0].start} às ${roomConflicts[0].end}.` };
    }

    // Teacher conflicts in other rooms
    for (const tId of teacherIds || []) {
      const tConflicts = state.lessons.filter(l =>
        l.id !== excludeLessonId &&
        l.teacherIds.includes(tId) &&
        l.date === date &&
        l.status !== 'canceled' &&
        hasTimeConflict(sMin, eMin, timeToMinutes(l.start), timeToMinutes(l.end))
      );
      if (tConflicts.length) {
        const teacher = findById('teachers', tId);
        const otherRoom = findById('rooms', tConflicts[0].roomId);
        return { message: `O professor ${teacher?.name} já está comprometido em ${formatDate(date)} das ${tConflicts[0].start} às ${tConflicts[0].end} na sala "${otherRoom?.name}".` };
      }
    }

    return null;
  }

  /**
   * Check student has remaining lessons.
   */
  function checkStudentBalance(studentId, neededLessons = 1) {
    const student = findById('students', studentId);
    if (!student) return { message: 'Aluno não encontrado.' };
    const status = getStudentLessonStatus(student);
    if (status.available < neededLessons) {
      const parts = [];
      parts.push(`${student.name} tem pacote de ${status.total} aula(s).`);
      parts.push(`Já foram realizadas: ${status.used}.`);
      parts.push(`Já agendadas (ainda não realizadas): ${status.scheduled}.`);
      parts.push(`Disponível para agendar: ${status.available}.`);
      parts.push(`Você está tentando agendar ${neededLessons} aula(s).`);
      const sugg = status.available > 0
        ? `Você pode agendar no máximo ${status.available} aula(s) agora, ou aumentar o pacote nas configurações do aluno.`
        : `Renove o pacote ou aumente o tamanho nas configurações do aluno antes de agendar.`;
      return { message: parts.join(' ') + ' ' + sugg };
    }
    return null;
  }

  function checkRoomCapacity(roomId, studentIds) {
    const room = findById('rooms', roomId);
    if (!room) return { message: 'Sala não encontrada.' };
    if (studentIds.length > room.capacity) {
      return { message: `A sala "${room.name}" comporta no máximo ${room.capacity} aluno(s), mas você está tentando incluir ${studentIds.length}. Escolha uma sala maior ou reduza o número de alunos.` };
    }
    return null;
  }

  // =========================================================
  // RENDER
  // =========================================================

  function rerender() {
    applyTheme();
    applyBrand();
    // Preserve focus and caret position on input/textarea elements that have an id
    const active = document.activeElement;
    let focusState = null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.id) {
      focusState = {
        id: active.id,
        start: active.selectionStart,
        end: active.selectionEnd,
        value: active.value
      };
    }
    const root = document.getElementById('root');
    if (!state.sessionActive || !state.currentUserId) {
      root.innerHTML = renderLogin();
      bindLoginEvents();
      return;
    }
    root.innerHTML = renderApp();
    bindAppEvents();
    // Restore focus
    if (focusState) {
      const el = document.getElementById(focusState.id);
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.focus();
        try {
          if (typeof focusState.start === 'number') {
            el.setSelectionRange(focusState.start, focusState.end);
          }
        } catch (e) { /* some input types don't support selection */ }
      }
    }
  }

  function applyTheme() {
    const html = document.documentElement;
    html.setAttribute('data-theme', state.settings.theme || 'light');
    html.setAttribute('data-palette', state.settings.palette || 'parchment');
    html.setAttribute('data-font', state.settings.fontFamily || 'default');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = state.settings.theme === 'dark' ? '#0a0a0a' : '#f8f5ef';
  }

  function applyBrand() {
    const color = state.settings.brand.primaryColor;
    if (color) {
      document.documentElement.style.setProperty('--accent', color);
    }
    document.title = state.settings.brand.name || 'TutorAgenda';
  }

  // =========================================================
  // LOGIN VIEW
  // =========================================================

  function renderLogin() {
    const brandName = state.settings.brand.name || 'TutorAgenda';
    return `
    <div class="screen-login">
      <div class="login-art">
        <div class="login-art-brand">${escapeHtml(brandName)}</div>
        <div class="login-art-hero">
          <h1>Aulas,<br/><em>organizadas</em><br/>com precisão.</h1>
          <p>Gestão completa de salas, professores, alunos e agendamentos — em tempo real, de qualquer dispositivo.</p>
        </div>
        <div class="login-art-footer">v1.0 · Desenvolvido com dedicação ao ensino</div>
      </div>

      <div class="login-form-wrap">
        <h2>Bem-vindo</h2>
        <p class="sub">Entre com suas credenciais para acessar o painel.</p>

        <form id="login-form" autocomplete="off">
          <div class="auth-mode-switch" role="tablist">
            <button type="button" class="auth-mode-btn active" data-mode="username" role="tab">Isaac</button>
            <button type="button" class="auth-mode-btn" data-mode="email" role="tab">E-mail</button>
            <button type="button" class="auth-mode-btn" data-mode="phone" role="tab">Telefone</button>
          </div>

          <div class="field">
            <label class="field-label" for="login-id" id="login-id-label">Nome de usuário</label>
            <input type="text" class="input" id="login-id" placeholder="Isaac" autocomplete="off" />
          </div>

          <div class="field">
            <label class="field-label" for="login-pw">Senha</label>
            <input type="password" class="input" id="login-pw" placeholder="••••••••" autocomplete="off" />
          </div>

          <button class="btn btn-primary btn-lg btn-block mt-sm" type="submit">Entrar</button>

          <div class="mt-md text-center text-sm">
            <a href="#" id="forgot-link" class="text-muted">Esqueci minha senha</a>
          </div>
        </form>
      </div>
    </div>
    `;
  }

  function bindLoginEvents() {
    const form = $('#login-form');
    const idInput = $('#login-id');
    const idLabel = $('#login-id-label');
    const modeBtns = $$('.auth-mode-btn');
    let mode = 'username';

    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mode = btn.dataset.mode;
        const labels = { username: 'Nome de usuário', email: 'E-mail', phone: 'Telefone' };
        const placeholders = { username: 'Usuário', email: 'voce@exemplo.com', phone: '(48) 99999-0000' };
        idLabel.textContent = labels[mode];
        idInput.placeholder = placeholders[mode];
        idInput.value = '';
      });
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const idVal = idInput.value.trim();
      const pw = $('#login-pw').value;
      if (!idVal || !pw) {
        showError('Campos obrigatórios', 'Preencha o identificador e a senha para entrar.');
        return;
      }
      const user = state.users.find(u => {
        if (mode === 'username') return (u.username || '').toLowerCase() === idVal.toLowerCase();
        if (mode === 'email') return (u.email || '').toLowerCase() === idVal.toLowerCase();
        if (mode === 'phone') return (u.phone || '').replace(/\D/g, '') === idVal.replace(/\D/g, '');
        return false;
      });
      if (!user || user.password !== pw) {
        showError('Falha no login', 'Usuário ou senha incorretos. Verifique suas credenciais e tente novamente.');
        return;
      }
      state.currentUserId = user.id;
      state.sessionActive = true;
      saveState();
      toast('ok', `Bem-vindo, ${user.username}!`, 'Login realizado com sucesso.');
      rerender();
    });

    $('#forgot-link').addEventListener('click', (e) => {
      e.preventDefault();
      openForgotModal();
    });
  }

  function openForgotModal() {
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Recuperar acesso</h3>
          <p class="modal-sub">Informe seu e-mail ou telefone para receber as instruções.</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="Fechar">${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">E-mail ou telefone cadastrado</label>
          <input class="input" id="forgot-id" placeholder="exemplo@email.com ou (48) 99999-0000" />
        </div>
        <p class="text-sm text-muted" style="margin:0">Em uma instalação de produção, aqui seria enviado um link/código. Nesta versão local, você pode redefinir a senha diretamente nas configurações quando logado — ou peça para um administrador.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="forgot-submit">Solicitar</button>
      </div>
    `, {
      size: 'sm',
      onMount: (node, close) => {
        node.querySelector('#forgot-submit').addEventListener('click', () => {
          const val = node.querySelector('#forgot-id').value.trim();
          if (!val) { showError('Preencha o campo', 'Informe um e-mail ou telefone.'); return; }
          const exists = state.users.some(u =>
            (u.email && u.email.toLowerCase() === val.toLowerCase()) ||
            (u.phone && u.phone.replace(/\D/g, '') === val.replace(/\D/g, ''))
          );
          close();
          if (exists) {
            toast('ok', 'Solicitação registrada', 'Se a conta existir, você receberá instruções.');
          } else {
            toast('info', 'Solicitação registrada', 'Verifique o identificador informado.');
          }
        });
      }
    });
  }

  // =========================================================
  // APP SHELL
  // =========================================================

  function renderApp() {
    const user = findById('users', state.currentUserId);
    const brandName = state.settings.brand.name || 'TutorAgenda';
    const routes = [
      { id: 'dashboard', label: 'Início', icon: 'home', group: 'Visão geral' },
      { id: 'calendar', label: 'Calendário', icon: 'cal', group: 'Visão geral' },
      { id: 'rooms', label: 'Salas', icon: 'room', group: 'Gestão' },
      { id: 'teachers', label: 'Professores', icon: 'users', group: 'Gestão' },
      { id: 'students', label: 'Alunos', icon: 'user', group: 'Gestão' },
      { id: 'groups', label: 'Grupos', icon: 'users', group: 'Gestão' },
      { id: 'replacements', label: 'Reposições', icon: 'repeat', group: 'Aulas' },
      { id: 'messages', label: 'Mensagens', icon: 'msg', group: 'Aulas' },
      { id: 'notes', label: 'Anotações', icon: 'edit', group: 'Aulas' },
      { id: 'financial', label: 'Financeiro', icon: 'money', group: 'Relatórios' },
      { id: 'reports', label: 'Relatórios', icon: 'chart', group: 'Relatórios' },
      { id: 'settings', label: 'Configurações', icon: 'gear', group: 'Sistema' }
    ];

    const groups = {};
    routes.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });

    const unread = state.notifications.filter(n => !n.read).length;

    const currentRoute = routes.find(r => r.id === appView.route) || routes[0];

    return `
    <div class="app">
      <div class="sidebar-backdrop ${appView.sidebarOpen ? 'open' : ''}" id="sidebar-backdrop"></div>
      <aside class="sidebar ${appView.sidebarOpen ? 'open' : ''}" id="sidebar">
        <div class="sidebar-brand">
          <div class="logo-mark">T</div>
          <div>
            <h1>${escapeHtml(brandName)}</h1>
            <div class="tagline">Painel de gestão</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${Object.entries(groups).map(([group, items]) => `
            <div class="nav-group">
              <div class="nav-group-label">${group}</div>
              ${items.map(r => {
                const isActive = r.id === appView.route;
                const alertsCount = r.id === 'dashboard' ? getCriticalAlertsCount() : 0;
                return `
                <button class="nav-item ${isActive ? 'active' : ''}" data-route="${r.id}">
                  ${icon(r.icon, 18, 'icon')}
                  <span>${r.label}</span>
                  ${alertsCount > 0 && r.id === 'dashboard' ? `<span class="badge">${alertsCount}</span>` : ''}
                </button>
                `;
              }).join('')}
            </div>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="avatar">${escapeHtml(initials(user?.username || '?'))}</div>
          <div class="user-info">
            <div class="user-name">${escapeHtml(user?.username || 'Usuário')}</div>
            <div class="user-role">${escapeHtml(user?.role === 'admin' ? 'Administrador' : 'Usuário')}</div>
          </div>
          <button class="btn-icon btn-ghost" data-action="logout" title="Sair" style="border:none;padding:8px">${icon('logout', 16)}</button>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="hamburger" id="hamburger" aria-label="Menu">${icon('menu', 18)}</button>
          <h2 class="topbar-title">${escapeHtml(currentRoute.label)}</h2>

          <div class="search-global hide-mobile">
            <span class="search-icon">${icon('search', 16)}</span>
            <input class="input" id="global-search" placeholder="Busca global..." autocomplete="off" />
          </div>

          <div class="topbar-actions">
            <button class="btn btn-ghost btn-icon" data-action="toggle-theme" title="Alternar tema" aria-label="Alternar tema">
              ${state.settings.theme === 'dark' ? icon('sun', 16) : icon('moon', 16)}
            </button>

            <div style="position:relative">
              <button class="btn btn-ghost btn-icon" id="notif-btn" title="Notificações" aria-label="Notificações">
                ${icon('bell', 16)}
                ${unread > 0 ? `<span class="badge" style="position:absolute;top:2px;right:2px;padding:2px 5px;font-size:.62rem;min-width:16px;background:var(--rose);color:white;border-radius:999px">${unread}</span>` : ''}
              </button>
              ${appView.notificationsOpen ? renderNotificationsPanel() : ''}
            </div>
          </div>
        </header>

        <div class="content">
          ${renderRoute()}
        </div>
      </div>
    </div>
    `;
  }

  function renderRoute() {
    switch (appView.route) {
      case 'dashboard': return renderDashboard();
      case 'calendar': return renderCalendar();
      case 'rooms': return renderRooms();
      case 'teachers': return renderTeachers();
      case 'students': return renderStudents();
      case 'groups': return renderGroups();
      case 'replacements': return renderReplacements();
      case 'messages': return renderMessages();
      case 'notes': return renderNotes();
      case 'financial': return renderFinancial();
      case 'reports': return renderReports();
      case 'settings': return renderSettings();
      default: return renderDashboard();
    }
  }

  function bindAppEvents() {
    $$('[data-route]').forEach(b => {
      b.addEventListener('click', () => {
        appView.route = b.dataset.route;
        appView.sidebarOpen = false;
        rerender();
      });
    });

    const logoutBtn = $('[data-action="logout"]');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
      showConfirm('Sair do sistema', 'Tem certeza que deseja encerrar a sessão?', () => {
        state.sessionActive = false;
        state.currentUserId = null;
        saveState();
        rerender();
      }, 'Sair');
    });

    const themeBtn = $('[data-action="toggle-theme"]');
    if (themeBtn) themeBtn.addEventListener('click', () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      saveState();
      rerender();
    });

    const notifBtn = $('#notif-btn');
    if (notifBtn) notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appView.notificationsOpen = !appView.notificationsOpen;
      if (appView.notificationsOpen) {
        // Mark as read on open
        state.notifications.forEach(n => n.read = true);
        saveState(true);
      }
      rerender();
    });
    document.addEventListener('click', handleNotifOutside);

    const hamburger = $('#hamburger');
    if (hamburger) hamburger.addEventListener('click', () => {
      appView.sidebarOpen = !appView.sidebarOpen;
      rerender();
    });
    const backdrop = $('#sidebar-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => {
      appView.sidebarOpen = false;
      rerender();
    });

    const globalSearch = $('#global-search');
    if (globalSearch) {
      globalSearch.addEventListener('input', (e) => handleGlobalSearch(e.target.value));
      globalSearch.addEventListener('focus', () => handleGlobalSearch(globalSearch.value));
    }

    // Bind route-specific events
    bindRouteEvents();
  }

  function handleNotifOutside(e) {
    if (!appView.notificationsOpen) return;
    if (e.target.closest('#notif-btn') || e.target.closest('.dropdown-panel')) return;
    appView.notificationsOpen = false;
    document.removeEventListener('click', handleNotifOutside);
    rerender();
  }

  function renderNotificationsPanel() {
    const notifs = state.notifications || [];
    return `
    <div class="dropdown-panel" role="dialog">
      <div class="dropdown-header">
        Notificações
        ${notifs.length > 0 ? '<button class="btn btn-sm btn-ghost" id="clear-notifs">Limpar</button>' : ''}
      </div>
      ${notifs.length === 0 ? `
        <div class="notif-empty">Nenhuma notificação no momento.</div>
      ` : notifs.map(n => `
        <div class="notif-item">
          <div class="notif-icon i-${n.type}">${icon(n.type === 'danger' ? 'alert' : n.type === 'warn' ? 'alert' : n.type === 'ok' ? 'check' : 'info', 14)}</div>
          <div class="notif-body">
            <div class="title">${escapeHtml(n.title)}</div>
            <div class="desc">${escapeHtml(n.desc || '')}</div>
            <div class="time">${relativeTime(n.time)}</div>
          </div>
        </div>
      `).join('')}
    </div>
    `;
  }

  function bindRouteEvents() {
    const clear = $('#clear-notifs');
    if (clear) clear.addEventListener('click', () => {
      state.notifications = [];
      saveState();
      rerender();
    });

    switch (appView.route) {
      case 'dashboard': bindDashboardEvents(); break;
      case 'calendar': bindCalendarEvents(); break;
      case 'rooms': bindRoomsEvents(); break;
      case 'teachers': bindTeachersEvents(); break;
      case 'students': bindStudentsEvents(); break;
      case 'groups': bindGroupsEvents(); break;
      case 'replacements': bindReplacementsEvents(); break;
      case 'messages': bindMessagesEvents(); break;
      case 'notes': bindNotesEvents(); break;
      case 'financial': bindFinancialEvents(); break;
      case 'reports': bindReportsEvents(); break;
      case 'settings': bindSettingsEvents(); break;
    }
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'agora';
    const min = Math.floor(sec / 60);
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
    return formatDate(dateToString(new Date(ts)));
  }

  function getCriticalAlertsCount() {
    return state.students.filter(s => {
      if (!s.active) return false;
      const st = getStudentLessonStatus(s);
      return st.remaining <= 1;
    }).length;
  }

  // Continue in the next file part — we inline everything.

  // =========================================================
  // GLOBAL SEARCH
  // =========================================================

  let globalSearchTimeout = null;
  function handleGlobalSearch(query) {
    clearTimeout(globalSearchTimeout);
    globalSearchTimeout = setTimeout(() => {
      if (!query || query.length < 2) {
        const existing = $('#search-results-dropdown');
        if (existing) existing.remove();
        return;
      }
      renderSearchResults(query);
    }, 200);
  }

  function renderSearchResults(query) {
    const q = query.toLowerCase();
    const results = [];

    state.students.forEach(s => {
      if (s.name.toLowerCase().includes(q)) {
        results.push({ type: 'student', label: s.name, sub: 'Aluno', id: s.id });
      }
    });
    state.teachers.forEach(t => {
      if (t.name.toLowerCase().includes(q)) {
        results.push({ type: 'teacher', label: t.name, sub: 'Professor', id: t.id });
      }
    });
    state.rooms.forEach(r => {
      if (r.name.toLowerCase().includes(q)) {
        results.push({ type: 'room', label: r.name, sub: 'Sala', id: r.id });
      }
    });

    const existing = $('#search-results-dropdown');
    if (existing) existing.remove();

    const search = $('#global-search');
    if (!search || results.length === 0) return;

    const dropdown = document.createElement('div');
    dropdown.id = 'search-results-dropdown';
    dropdown.className = 'dropdown-panel';
    dropdown.style.top = 'calc(100% + 4px)';
    dropdown.style.left = '0';
    dropdown.style.right = 'auto';
    dropdown.style.minWidth = '300px';
    dropdown.innerHTML = results.slice(0, 10).map(r => `
      <div class="notif-item" data-search-type="${r.type}" data-search-id="${r.id}">
        <div class="notif-icon i-info">${icon(r.type === 'student' ? 'user' : r.type === 'teacher' ? 'users' : 'room', 14)}</div>
        <div class="notif-body">
          <div class="title">${escapeHtml(r.label)}</div>
          <div class="desc">${r.sub}</div>
        </div>
      </div>
    `).join('');

    search.parentElement.style.position = 'relative';
    search.parentElement.appendChild(dropdown);

    dropdown.querySelectorAll('[data-search-type]').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.searchType;
        const id = item.dataset.searchId;
        if (type === 'student') { appView.route = 'students'; setTimeout(() => openStudentModal(id), 50); }
        if (type === 'teacher') { appView.route = 'teachers'; setTimeout(() => openTeacherModal(id), 50); }
        if (type === 'room') { appView.route = 'rooms'; setTimeout(() => openRoomModal(id), 50); }
        search.value = '';
        dropdown.remove();
        rerender();
      });
    });
  }

  // === VIEWS ARE APPENDED BELOW ===
  // (placeholder — see end of file for initial render)


  // =========================================================
  // DASHBOARD VIEW
  // =========================================================

  function renderDashboard() {
    const today = todayStr();
    const activeTeachers = state.teachers.filter(t => t.active).length;
    const activeStudents = state.students.filter(s => s.active).length;
    const activeRooms = state.rooms.filter(r => r.active).length;

    const todayLessons = state.lessons.filter(l => l.date === today && l.status !== 'canceled')
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6);
    const weekLessons = state.lessons.filter(l => l.date >= weekStart && l.date <= weekEnd && l.status !== 'canceled');

    const tomorrow = addDays(today, 1);
    const tomorrowLessons = state.lessons.filter(l => l.date === tomorrow && l.status !== 'canceled')
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

    const critical = state.students.filter(s => {
      if (!s.active) return false;
      const st = getStudentLessonStatus(s);
      return st.remaining <= 1;
    });

    const chartData = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const count = state.lessons.filter(l => l.date === d && l.status !== 'canceled').length;
      chartData.push({ label: dowLabel(i), count, date: d });
    }
    const maxCount = Math.max(1, ...chartData.map(c => c.count));

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Olá, bem-vindo de volta</h2>
          <div class="section-sub">${dowLabel(new Date().getDay(), false)}, ${formatDate(today, { day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </div>
        <div class="flex gap-sm">
          <button class="btn btn-accent" id="quick-new-lesson">${icon('plus', 14)} Novo agendamento</button>
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric">
          <div class="metric-label">Aulas hoje</div>
          <div class="metric-value">${todayLessons.length}</div>
          <div class="metric-delta">${todayLessons.filter(l => l.status === 'done').length} concluídas</div>
        </div>
        <div class="metric m-teal">
          <div class="metric-label">Aulas na semana</div>
          <div class="metric-value">${weekLessons.length}</div>
          <div class="metric-delta">${weekLessons.filter(l => l.status === 'done').length} concluídas</div>
        </div>
        <div class="metric m-info">
          <div class="metric-label">Alunos ativos</div>
          <div class="metric-value">${activeStudents}</div>
          <div class="metric-delta">de ${state.students.length} totais</div>
        </div>
        <div class="metric m-rose">
          <div class="metric-label">Professores</div>
          <div class="metric-value">${activeTeachers}</div>
          <div class="metric-delta">${activeRooms} sala${activeRooms !== 1 ? 's' : ''} ativa${activeRooms !== 1 ? 's' : ''}</div>
        </div>
      </div>

      <div class="dashboard-grid">
        <div class="card">
          <div class="flex items-center justify-between mb-md">
            <div>
              <div class="card-title">Agenda de hoje</div>
              <div class="card-sub">Aulas programadas em ordem de horário</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-route="calendar">Ver calendário</button>
          </div>
          ${todayLessons.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">${icon('cal', 24)}</div>
              <h3>Nenhuma aula hoje</h3>
              <p>Aproveite para organizar a semana ou entrar em contato com alunos.</p>
            </div>
          ` : `
            <div class="today-list">
              ${todayLessons.map(l => renderTodayItem(l)).join('')}
            </div>
          `}

          <div class="divider"></div>

          <div class="flex items-center justify-between mb-md">
            <div>
              <div class="card-title">Aulas por dia — esta semana</div>
              <div class="card-sub">Distribuição ao longo dos dias</div>
            </div>
          </div>
          <div class="chart-container">
            <div class="bar-chart">
              ${chartData.map(b => `
                <div class="bar" title="${b.label}: ${b.count} aula(s)">
                  <div class="bar-fill" style="height: ${(b.count / maxCount) * 100}%">
                    <span class="bar-value">${b.count}</span>
                  </div>
                  <div class="bar-label">${b.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-md">
          <div class="card">
            <div class="card-title">Alertas</div>
            <div class="card-sub">Alunos com saldo crítico</div>
            ${critical.length === 0 ? `
              <div class="text-sm text-subtle" style="padding:12px 0">Nenhum alerta ativo. Todos os alunos possuem saldo adequado.</div>
            ` : critical.slice(0, 6).map(s => {
              const st = getStudentLessonStatus(s);
              return `
              <div class="alert-item ${st.remaining === 0 ? 'crit' : ''}" data-alert-student="${s.id}" style="cursor:pointer">
                ${icon('alert', 14)}
                <div style="flex:1">
                  <div style="font-weight:500">${escapeHtml(s.name)}</div>
                  <div style="font-size:.78rem;opacity:.85">${st.remaining} aula(s) restante(s)</div>
                </div>
              </div>`;
            }).join('')}
          </div>

          <div class="card">
            <div class="flex items-center justify-between mb-md">
              <div>
                <div class="card-title">Lembretes de amanhã</div>
                <div class="card-sub">Envie mensagens via WhatsApp</div>
              </div>
            </div>
            ${tomorrowLessons.length === 0 ? `
              <div class="text-sm text-subtle" style="padding:12px 0">Nenhuma aula agendada para amanhã.</div>
            ` : tomorrowLessons.slice(0, 6).map(l => renderReminderItem(l)).join('')}
          </div>
        </div>
      </div>
    </div>
    `;
  }

  function renderTodayItem(l) {
    const room = findById('rooms', l.roomId);
    const teachers = l.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
    const students = l.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
    const borderColor = room?.color || '#c6833a';
    const statusBadge = l.status === 'done' ? '<span class="badge badge-ok badge-dot">Concluída</span>'
      : l.status === 'canceled' ? '<span class="badge badge-danger badge-dot">Cancelada</span>'
      : '<span class="badge badge-neutral badge-dot">Agendada</span>';
    return `
    <div class="today-item" data-lesson-id="${l.id}" style="border-left-color: ${borderColor}">
      <div class="time-block">${l.start}<br/><span style="opacity:.6">${l.end}</span></div>
      <div class="info">
        <div class="title">${escapeHtml(students || 'Sem aluno')} ${statusBadge}</div>
        <div class="sub">${escapeHtml(teachers || 'Sem professor')} · ${escapeHtml(room?.name || 'Sem sala')}</div>
      </div>
    </div>
    `;
  }

  function renderReminderItem(l) {
    const room = findById('rooms', l.roomId);
    const teachers = l.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
    const students = l.studentIds.map(id => findById('students', id)).filter(Boolean);
    if (students.length === 0) return '';
    return students.map(s => `
      <div class="alert-item" style="background:var(--info-soft); color:var(--info-ink); margin-bottom:6px">
        ${icon('clock', 14)}
        <div style="flex:1;min-width:0">
          <div style="font-weight:500">${escapeHtml(s.name)} · ${l.start}</div>
          <div style="font-size:.78rem;opacity:.85">${escapeHtml(teachers)} · ${escapeHtml(room?.name || '')}</div>
        </div>
        <button class="btn btn-sm btn-ghost" data-wa-lesson="${l.id}" data-wa-student="${s.id}" title="Enviar WhatsApp">${icon('wa', 14)}</button>
        <button class="btn btn-sm btn-ghost" data-copy-lesson="${l.id}" data-copy-student="${s.id}" title="Copiar">${icon('copy', 14)}</button>
      </div>
    `).join('');
  }

  function bindDashboardEvents() {
    $$('[data-lesson-id]').forEach(el => {
      el.addEventListener('click', () => openLessonDetailModal(el.dataset.lessonId));
    });
    $$('[data-alert-student]').forEach(el => {
      el.addEventListener('click', () => openStudentModal(el.dataset.alertStudent));
    });
    $$('[data-wa-lesson]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        sendWhatsAppReminder(el.dataset.waLesson, el.dataset.waStudent);
      });
    });
    $$('[data-copy-lesson]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        copyReminderText(el.dataset.copyLesson, el.dataset.copyStudent);
      });
    });
    const qnl = $('#quick-new-lesson');
    if (qnl) qnl.addEventListener('click', () => openLessonCreateModal());
  }

  function sendWhatsAppReminder(lessonId, studentId) {
    const lesson = findById('lessons', lessonId);
    const student = findById('students', studentId);
    if (!lesson || !student) return;
    const text = buildReminderText(lesson, student);
    const phone = (student.phone || student.guardianPhone || '').replace(/\D/g, '');
    let url;
    if (phone) {
      const withCountry = phone.startsWith('55') ? phone : '55' + phone;
      url = `https://wa.me/${withCountry}?text=${encodeURIComponent(text)}`;
    } else {
      url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    }
    window.open(url, '_blank');
    state.messageLog.push({
      id: uid('msg'), studentId, lessonId, channel: 'whatsapp', text, sentAt: Date.now()
    });
    saveState();
    toast('ok', 'Mensagem aberta no WhatsApp', `Para ${student.name}`);
  }

  function copyReminderText(lessonId, studentId) {
    const lesson = findById('lessons', lessonId);
    const student = findById('students', studentId);
    if (!lesson || !student) return;
    const text = buildReminderText(lesson, student);
    navigator.clipboard.writeText(text).then(() => {
      toast('ok', 'Copiado!', 'Mensagem copiada para a área de transferência');
      state.messageLog.push({
        id: uid('msg'), studentId, lessonId, channel: 'clipboard', text, sentAt: Date.now()
      });
      saveState();
    }).catch(() => {
      showError('Erro', 'Não foi possível copiar para a área de transferência.');
    });
  }

  function buildReminderText(lesson, student) {
    const room = findById('rooms', lesson.roomId);
    const teachers = lesson.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
    const template = state.settings.whatsappReminderTemplate || 'Olá {aluno}! Amanhã você tem aula às {horaInicio}.';
    return template
      .replaceAll('{aluno}', student.name)
      .replaceAll('{data}', formatDate(lesson.date, { day: '2-digit', month: '2-digit' }))
      .replaceAll('{horaInicio}', lesson.start)
      .replaceAll('{horaFim}', lesson.end)
      .replaceAll('{professor}', teachers || 'o professor')
      .replaceAll('{sala}', room?.name || '');
  }

  // =========================================================
  // CALENDAR VIEW
  // =========================================================

  function renderCalendar() {
    const isZoom = appView.zoomMode;
    const scalePct = Math.round((appView.zoomScale || 1) * 100);
    const tx = appView.zoomPanX || 0;
    const ty = appView.zoomPanY || 0;
    const sc = appView.zoomScale || 1;
    return `
    <div class="${isZoom ? 'zoom-mode-active' : ''}" id="calendar-root" style="--zoom-mult:${sc}">
      ${renderCalendarToolbar()}
      <div id="calendar-content" style="position:relative;overflow:hidden">
        <div class="zoom-viewport" id="zoom-viewport" style="transform:translate(${tx}px, ${ty}px);transform-origin:0 0;will-change:transform">
          ${renderCalendarContent()}
        </div>
      </div>
      ${isZoom ? `
      <div class="zoom-floating-indicator">
        <button id="zoom-float-in" type="button" title="Aumentar">${icon('zoom', 20)}</button>
        <div class="zoom-level-badge">${scalePct}%</div>
        <button id="zoom-float-out" type="button" title="Diminuir">${icon('zoom-out', 20)}</button>
        <button id="zoom-float-reset" type="button" title="Resetar" style="font-family:var(--font-mono);font-size:.72rem">1:1</button>
        <button id="zoom-exit-float" type="button" title="Sair do zoom" class="zoom-floating-close">${icon('close', 20)}</button>
      </div>
      ` : ''}
    </div>
    `;
  }

  function renderCalendarToolbar() {
    return `
    <div class="calendar-toolbar">
      <div class="date-nav">
        <button data-cal-nav="prev" title="Anterior">${icon('chev-left', 16)}</button>
        <button class="date-label" id="cal-date-label" title="Ir para data" type="button">${calendarLabel()}</button>
        <button data-cal-nav="next" title="Próximo">${icon('chev-right', 16)}</button>
      </div>
      <button class="btn btn-ghost btn-sm" data-cal-nav="today">Hoje</button>

      <div class="zoom-selector">
        <button class="${appView.calendarZoom === 'day' ? 'active' : ''}" data-zoom="day">Dia</button>
        <button class="${appView.calendarZoom === 'week' ? 'active' : ''}" data-zoom="week">Semana</button>
        <button class="${appView.calendarZoom === 'month' ? 'active' : ''}" data-zoom="month">Mês</button>
        <button class="${appView.calendarZoom === 'timeline' ? 'active' : ''}" data-zoom="timeline">Timeline</button>
      </div>

      ${appView.calendarZoom !== 'month' ? `
        <div class="zoom-selector">
          <button class="${appView.calendarInterval === 15 ? 'active' : ''}" data-interval="15">15 min</button>
          <button class="${appView.calendarInterval === 30 ? 'active' : ''}" data-interval="30">30 min</button>
          <button class="${appView.calendarInterval === 60 ? 'active' : ''}" data-interval="60">1 h</button>
        </div>
      ` : ''}

      <div style="flex:1"></div>

      <select class="select" id="filter-room" style="max-width:160px">
        <option value="">Todas as salas</option>
        ${state.rooms.filter(r => r.active).map(r => `<option value="${r.id}" ${appView.calendarFilterRoom === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
      </select>
      <select class="select" id="filter-teacher" style="max-width:180px">
        <option value="">Todos os professores</option>
        ${state.teachers.filter(t => t.active).map(t => `<option value="${t.id}" ${appView.calendarFilterTeacher === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" id="holidays-btn">${icon('flag', 14)} Feriados</button>
      <button class="btn btn-ghost btn-sm ${appView.zoomMode ? 'btn-accent-active' : ''}" id="zoom-toggle-btn" title="Modo zoom (pressione L)">${icon('zoom', 14)} ${appView.zoomMode ? 'Sair do zoom' : 'Zoom'}</button>
      ${appView.zoomMode ? `
      <div class="zoom-controls-inline">
        <button id="zoom-out-btn" type="button" title="Diminuir (−)">${icon('zoom-out', 14)}</button>
        <span class="zoom-level">${Math.round((appView.zoomScale || 1) * 100)}%</span>
        <button id="zoom-in-btn" type="button" title="Aumentar (+)">${icon('zoom', 14)}</button>
        <button id="zoom-reset-btn" type="button" title="Resetar ao padrão" style="font-size:.72rem;font-family:var(--font-mono);padding:0 8px;width:auto">1:1</button>
      </div>
      ` : ''}
      <button class="btn btn-accent btn-sm" id="new-lesson-btn">${icon('plus', 14)} Novo</button>
    </div>
    `;
  }

  function calendarLabel() {
    if (appView.calendarZoom === 'day') {
      return formatDate(appView.calendarDate, { weekday: 'long', day: 'numeric', month: 'long' });
    }
    if (appView.calendarZoom === 'month') {
      const d = parseDate(appView.calendarDate);
      return `${monthLabel(d.getMonth())} ${d.getFullYear()}`;
    }
    const ws = startOfWeek(appView.calendarDate);
    const we = addDays(ws, 6);
    return `${formatDate(ws, { day: 'numeric', month: 'short' })} — ${formatDate(we, { day: 'numeric', month: 'short' })}`;
  }

  function renderCalendarContent() {
    if (appView.calendarZoom === 'month') return renderCalendarMonth();
    if (appView.calendarZoom === 'timeline') return renderCalendarTimeline();
    if (appView.calendarZoom === 'day') return renderCalendarWeekOrDay('day');
    return renderCalendarWeekOrDay('week');
  }

  function renderCalendarWeekOrDay(mode) {
    const today = todayStr();
    const ws = mode === 'day' ? appView.calendarDate : startOfWeek(appView.calendarDate);
    const days = [];
    const n = mode === 'day' ? 1 : 7;
    for (let i = 0; i < n; i++) days.push(addDays(ws, i));

    const startMin = timeToMinutes(state.settings.workStart);
    const endMin = timeToMinutes(state.settings.workEnd);
    const interval = appView.calendarInterval;
    const ROW_PX = interval === 15 ? 14 : interval === 30 ? 22 : 40;

    const rows = [];
    for (let t = startMin; t < endMin; t += interval) rows.push(t);

    const headerCols = days.map(d => {
      const dObj = parseDate(d);
      const isToday = d === today;
      const isHol = isHoliday(d);
      const isNonWork = !state.settings.workDays.includes(dObj.getDay()) && !isHol;
      return `
        <div class="col-day ${isToday ? 'today' : ''} ${isHol ? 'holiday' : ''} ${isNonWork ? 'non-workday' : ''}">
          <div class="dow">${dowLabel(dObj.getDay())}</div>
          <div class="dom">${dObj.getDate()}</div>
        </div>
      `;
    }).join('');

    const hourCol = rows.map(r => `
      <div class="hour-row" style="height:${ROW_PX}px">${r % 60 === 0 ? minutesToTime(r) : ''}</div>
    `).join('');

    const workStartM = timeToMinutes(state.settings.workStart);
    const workEndM = timeToMinutes(state.settings.workEnd);
    const breakEnabled = state.settings.breakEnabled;
    const breakStartM = timeToMinutes(state.settings.breakStart);
    const breakEndM = timeToMinutes(state.settings.breakEnd);

    const dayCols = days.map(d => {
      const dObj = parseDate(d);
      const isHol = isHoliday(d);
      const isToday = d === today;
      const isNonWork = !state.settings.workDays.includes(dObj.getDay()) && !isHol;
      const cells = rows.map((r) => {
        const isQuarter = r % 60 !== 0;
        return `<div class="hour-cell ${isQuarter ? 'quarter-line' : ''}" style="height:${ROW_PX}px" data-day="${d}" data-minute="${r}"></div>`;
      }).join('');

      const dayLessons = filteredLessons().filter(l => l.date === d);
      const dayBlocks = state.blocks.filter(b => b.roomId && b.date === d &&
        (!appView.calendarFilterRoom || b.roomId === appView.calendarFilterRoom));

      const events = buildVisualEvents(dayLessons, dayBlocks, startMin, ROW_PX, interval);

      // Break overlay
      let breakOverlay = '';
      if (breakEnabled && breakStartM < breakEndM && !isHol && !isNonWork) {
        const bTop = ((breakStartM - startMin) / interval) * ROW_PX;
        const bHeight = ((breakEndM - breakStartM) / interval) * ROW_PX;
        if (bTop >= 0 && bHeight > 0) {
          breakOverlay = `<div class="break-overlay" style="top:${bTop}px;height:${bHeight}px">pausa</div>`;
        }
      }

      // Confirm-day button (only if there are scheduled lessons)
      const scheduledCount = dayLessons.filter(l => l.status === 'scheduled').length;
      const confirmBtn = scheduledCount > 0
        ? `<button class="confirm-day-btn" data-confirm-day="${d}" type="button">✓ Confirmar aulas (${scheduledCount})</button>`
        : '';

      return `
        <div class="calendar-day-col ${isToday ? 'today' : ''} ${isHol ? 'holiday' : ''} ${isNonWork ? 'non-workday' : ''}" data-day-col="${d}" style="position:relative">
          ${cells}
          ${breakOverlay}
          ${events.map(ev => renderCalendarEvent(ev)).join('')}
          ${confirmBtn}
        </div>
      `;
    }).join('');

    const gridCols = mode === 'day' ? '1fr' : 'repeat(7, 1fr)';
    const HOUR_W = 64;

    return `
    <div class="calendar-week">
      <div class="calendar-week-header" style="display:grid;grid-template-columns:${HOUR_W}px 1fr;box-sizing:border-box">
        <div class="col-hour-label" style="border-right:1px solid var(--line)"></div>
        <div style="display:grid;grid-template-columns:${gridCols};box-sizing:border-box">
          ${headerCols}
        </div>
      </div>
      <div class="calendar-week-grid" id="calendar-scroll" style="display:grid;grid-template-columns:${HOUR_W}px 1fr;box-sizing:border-box">
        <div class="col-hour" style="border-right:1px solid var(--line);box-sizing:border-box">
          ${hourCol}
        </div>
        <div class="calendar-week-cols" style="grid-template-columns:${gridCols};box-sizing:border-box">
          ${dayCols}
        </div>
      </div>
    </div>
    `;
  }

  function buildVisualEvents(lessons, blocks, startMin, rowPx, interval) {
    const events = [];
    const sorted = [...lessons].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    const used = new Set();

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(sorted[i].id)) continue;
      const l = sorted[i];
      let groupEnd = timeToMinutes(l.end);
      const group = [l];
      used.add(l.id);
      const sig = lessonSig(l);
      for (let j = i + 1; j < sorted.length; j++) {
        const nxt = sorted[j];
        if (used.has(nxt.id)) continue;
        if (lessonSig(nxt) === sig && timeToMinutes(nxt.start) === groupEnd) {
          group.push(nxt);
          used.add(nxt.id);
          groupEnd = timeToMinutes(nxt.end);
        } else {
          break;
        }
      }
      events.push({ kind: 'lesson', lessons: group, start: timeToMinutes(l.start), end: groupEnd, primaryId: l.id });
    }

    blocks.forEach(b => {
      events.push({ kind: 'block', block: b, start: timeToMinutes(b.start), end: timeToMinutes(b.end) });
    });

    // Lay out overlapping events in parallel columns (greedy)
    // Sort by start time, then by duration (longer first)
    const byStart = [...events].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    // Find clusters of overlapping events
    const clusters = [];
    let current = [];
    let clusterEnd = -1;
    byStart.forEach(ev => {
      if (ev.start < clusterEnd) {
        current.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.end);
      } else {
        if (current.length) clusters.push(current);
        current = [ev];
        clusterEnd = ev.end;
      }
    });
    if (current.length) clusters.push(current);

    // For each cluster, assign columns
    clusters.forEach(cluster => {
      const cols = []; // each col is list of events
      cluster.forEach(ev => {
        let placed = false;
        for (let c = 0; c < cols.length; c++) {
          const last = cols[c][cols[c].length - 1];
          if (last.end <= ev.start) {
            cols[c].push(ev);
            ev._col = c;
            placed = true;
            break;
          }
        }
        if (!placed) {
          ev._col = cols.length;
          cols.push([ev]);
        }
      });
      const totalCols = cols.length;
      cluster.forEach(ev => {
        ev._totalCols = totalCols;
      });
    });

    return events.map(ev => {
      const topMin = ev.start - startMin;
      const top = (topMin / interval) * rowPx;
      const height = ((ev.end - ev.start) / interval) * rowPx;
      const colWidth = 100 / (ev._totalCols || 1);
      const leftPct = (ev._col || 0) * colWidth;
      return { ...ev, top, height, leftPct, widthPct: colWidth };
    });
  }

  function lessonSig(l) {
    return `${l.roomId}|${[...l.teacherIds].sort().join(',')}|${[...l.studentIds].sort().join(',')}|${l.packageGroupId || ''}|${l.status}`;
  }

  function renderCalendarEvent(ev) {
    const left = `calc(${ev.leftPct}% + 2px)`;
    const width = `calc(${ev.widthPct}% - 4px)`;
    if (ev.kind === 'block') {
      return `
      <div class="cal-event block-event" data-block-id="${ev.block.id}" style="top:${ev.top}px;height:${ev.height}px;left:${left};width:${width};right:auto">
        <div class="cal-event-time">${ev.block.start} — ${ev.block.end}</div>
        <div class="cal-event-title">${escapeHtml(ev.block.label || 'Bloqueio')}</div>
      </div>`;
    }
    const first = ev.lessons[0];
    const last = ev.lessons[ev.lessons.length - 1];
    const room = findById('rooms', first.roomId);
    const teachers = first.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
    const students = first.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
    const color = room?.color || '#c6833a';
    const statusClass = first.status === 'done' ? 'status-done' : first.status === 'canceled' ? 'status-canceled' : '';
    const bg = hexToSoftBg(color);
    return `
    <div class="cal-event ${statusClass}" data-lesson-id="${first.id}" ${appView.zoomMode ? '' : 'draggable="true"'} style="top:${ev.top}px;height:${ev.height}px;left:${left};width:${width};right:auto;background:${bg};color:${darkenHex(color)};border-left-color:${color}">
      <div class="cal-event-time">${first.start} — ${last.end}${ev.lessons.length > 1 ? ` · ${ev.lessons.length} aulas` : ''}</div>
      <div class="cal-event-title">${escapeHtml(students || 'Sem aluno')}</div>
      <div class="cal-event-sub">${escapeHtml(teachers)} · ${escapeHtml(room?.name || '')}</div>
    </div>`;
  }

  function hexToSoftBg(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 'var(--accent-soft)';
    const isDark = state.settings.theme === 'dark';
    return isDark
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`
      : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`;
  }

  function darkenHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 'var(--accent-ink)';
    const isDark = state.settings.theme === 'dark';
    if (isDark) {
      const f = 0.6;
      return `rgb(${Math.round(rgb.r + (255 - rgb.r) * f)}, ${Math.round(rgb.g + (255 - rgb.g) * f)}, ${Math.round(rgb.b + (255 - rgb.b) * f)})`;
    }
    const f = 0.5;
    return `rgb(${Math.round(rgb.r * f)}, ${Math.round(rgb.g * f)}, ${Math.round(rgb.b * f)})`;
  }

  function hexToRgb(hex) {
    if (!hex) return null;
    const m = hex.replace('#', '').match(/.{1,2}/g);
    if (!m || m.length < 3) return null;
    return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
  }

  function renderCalendarMonth() {
    const d = parseDate(appView.calendarDate);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const firstDow = first.getDay();
    const gridStart = addDays(dateToString(first), -firstDow);
    const today = todayStr();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const dateStr = addDays(gridStart, i);
      const dObj = parseDate(dateStr);
      const inMonth = dObj.getMonth() === d.getMonth();
      const isToday = dateStr === today;
      const isHol = isHoliday(dateStr);
      const dayLessons = filteredLessons().filter(l => l.date === dateStr && l.status !== 'canceled');
      cells.push({ date: dateStr, dObj, inMonth, isToday, isHol, lessons: dayLessons });
    }

    return `
    <div class="calendar-month">
      <div class="calendar-month-dow">
        ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="calendar-month-grid">
        ${cells.map(c => {
          const maxShow = 3;
          const scheduledCount = c.lessons.filter(l => l.status === 'scheduled').length;
          return `
            <div class="month-cell ${c.inMonth ? '' : 'out-of-month'} ${c.isToday ? 'today' : ''} ${c.isHol ? 'holiday' : ''}" data-month-day="${c.date}">
              <div class="dom">${c.dObj.getDate()}</div>
              ${c.lessons.slice(0, maxShow).map(l => {
                const room = findById('rooms', l.roomId);
                const students = l.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
                return `<div class="month-event" style="background:${hexToSoftBg(room?.color || '#c6833a')};color:${darkenHex(room?.color || '#c6833a')};border-left-color:${room?.color || '#c6833a'}" data-lesson-id="${l.id}">${l.start} ${escapeHtml(students)}</div>`;
              }).join('')}
              ${c.lessons.length > maxShow ? `<div class="month-event more-link">+${c.lessons.length - maxShow} mais</div>` : ''}
              ${scheduledCount > 0 ? `<button class="confirm-day-btn" data-confirm-day="${c.date}" type="button">✓ (${scheduledCount})</button>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
    `;
  }

  function renderCalendarTimeline() {
    const rooms = state.rooms.filter(r => r.active && (!appView.calendarFilterRoom || r.id === appView.calendarFilterRoom));
    const day = appView.calendarDate;
    const startMin = timeToMinutes(state.settings.workStart);
    const endMin = timeToMinutes(state.settings.workEnd);
    const totalMin = endMin - startMin;
    const hourWidth = 80;
    const totalWidth = (totalMin / 60) * hourWidth;
    const hours = [];
    for (let t = startMin; t <= endMin; t += 60) hours.push(t);

    return `
    <div class="calendar-timeline">
      <div class="timeline-header">
        <div style="padding:12px 14px;font-family:var(--font-display);font-style:italic;font-size:1.05rem;border-right:1px solid var(--line)">
          ${formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div class="timeline-header-hours" style="grid-template-columns:repeat(${hours.length - 1}, 1fr);min-width:${totalWidth}px">
          ${hours.slice(0, -1).map(h => `<div class="timeline-hour-tick">${minutesToTime(h)}</div>`).join('')}
        </div>
      </div>
      ${rooms.length === 0 ? `
        <div class="empty-state" style="padding:2rem">
          <h3>Nenhuma sala ativa</h3>
          <p>Cadastre salas ativas para ver a linha do tempo.</p>
        </div>
      ` : rooms.map(room => {
        const dayLessons = filteredLessons().filter(l => l.date === day && l.roomId === room.id);
        const dayBlocks = state.blocks.filter(b => b.roomId === room.id && b.date === day);
        return `
          <div class="timeline-row">
            <div class="timeline-room">
              <div class="entity-color-dot" style="background:${room.color}"></div>
              <div>
                <div class="timeline-room-name">${escapeHtml(room.name)}</div>
                <div class="timeline-room-meta">${room.capacity} lugares</div>
              </div>
            </div>
            <div class="timeline-events" style="min-width:${totalWidth}px;background-size:${hourWidth}px 100%">
              ${dayLessons.map(l => {
                const left = ((timeToMinutes(l.start) - startMin) / 60) * hourWidth;
                const w = ((timeToMinutes(l.end) - timeToMinutes(l.start)) / 60) * hourWidth;
                const students = l.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
                return `<div class="timeline-event" style="left:${left}px;width:${w - 2}px;background:${hexToSoftBg(room.color)};color:${darkenHex(room.color)};border-left-color:${room.color}" data-lesson-id="${l.id}">
                  <div style="font-size:.7rem;opacity:.85;font-family:var(--font-mono)">${l.start}—${l.end}</div>
                  <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(students)}</div>
                </div>`;
              }).join('')}
              ${dayBlocks.map(b => {
                const left = ((timeToMinutes(b.start) - startMin) / 60) * hourWidth;
                const w = ((timeToMinutes(b.end) - timeToMinutes(b.start)) / 60) * hourWidth;
                return `<div class="timeline-event" style="left:${left}px;width:${w - 2}px;background:var(--bg-sunken);color:var(--ink-muted);border-left-color:var(--ink-muted);opacity:.7" data-block-id="${b.id}">
                  <div style="font-size:.7rem;font-family:var(--font-mono)">${b.start}—${b.end}</div>
                  <div style="font-weight:500">${escapeHtml(b.label || 'Bloqueio')}</div>
                </div>`;
              }).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
    `;
  }

  function filteredLessons() {
    return state.lessons.filter(l => {
      if (appView.calendarFilterRoom && l.roomId !== appView.calendarFilterRoom) return false;
      if (appView.calendarFilterTeacher && !l.teacherIds.includes(appView.calendarFilterTeacher)) return false;
      return true;
    });
  }

  let dragState = null;

  // =========================================================
  // CALENDAR ZOOM SYSTEM
  // =========================================================

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 0.15;

  /**
   * Apply current zoom scale (via --zoom-mult CSS var) + pan (via transform translate).
   * The layout expands physically (columns wider, cells taller) — text stays readable.
   * Pan is in screen pixels (no scale applied to translate).
   */
  function applyZoomTransform() {
    const root = document.getElementById('calendar-root');
    const viewport = document.getElementById('zoom-viewport');
    if (!root) return;
    const s = appView.zoomScale || 1;
    root.style.setProperty('--zoom-mult', s);
    if (viewport) {
      viewport.style.transformOrigin = '0 0';
      viewport.style.transform = `translate(${appView.zoomPanX}px, ${appView.zoomPanY}px)`;
    }
    document.querySelectorAll('.zoom-scale-readout, .zoom-level, .zoom-level-badge').forEach(el => {
      el.textContent = `${Math.round(s * 100)}%`;
    });
  }

  function clampZoom(scale) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  }

  /**
   * Clamp pan so the expanded content always COVERS the visible container.
   * After layout expansion, the viewport offsetWidth/Height already reflect the new size.
   * For the content to fully cover the container with transform-origin 0 0:
   *   panX ∈ [cw - viewportW, 0]   (if viewportW ≥ cw)
   *   panY ∈ [ch - viewportH, 0]
   */
  function clampPan() {
    const content = document.getElementById('calendar-content');
    const viewport = document.getElementById('zoom-viewport');
    if (!content || !viewport) return;
    const cw = content.offsetWidth;
    const ch = content.offsetHeight;
    const vw = viewport.offsetWidth;   // already reflects layout expansion
    const vh = viewport.offsetHeight;

    if (vw <= cw) {
      appView.zoomPanX = 0;
    } else {
      const minX = cw - vw;  // most negative — right edge of content aligned with right of container
      const maxX = 0;
      appView.zoomPanX = Math.min(maxX, Math.max(minX, appView.zoomPanX));
    }

    if (vh <= ch) {
      appView.zoomPanY = 0;
    } else {
      const minY = ch - vh;
      const maxY = 0;
      appView.zoomPanY = Math.min(maxY, Math.max(minY, appView.zoomPanY));
    }
  }

  /**
   * Cursor-centered zoom with layout expansion.
   * Content coord under cursor = mouse - pan (no division by scale — layout is physical).
   * To keep that point fixed: newPan = mouse - contentPoint * ratio
   * Then clamp so no blank edges appear.
   */
  function zoomAtPoint(clientX, clientY, newScale) {
    const content = document.getElementById('calendar-content');
    const root = document.getElementById('calendar-root');
    if (!content || !root) return;

    const oldScale = appView.zoomScale || 1;
    const clamped = clampZoom(newScale);
    if (Math.abs(clamped - oldScale) < 0.0005) return;

    const rect = content.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    // Content point under cursor in CURRENT expanded layout (1:1 mapping)
    const contentX = mouseX - appView.zoomPanX;
    const contentY = mouseY - appView.zoomPanY;

    // After expansion ratio, that point moves to contentX * ratio in the new layout
    const ratio = clamped / oldScale;

    appView.zoomScale = clamped;
    root.style.setProperty('--zoom-mult', clamped);

    // Keep the same physical point under the cursor
    appView.zoomPanX = mouseX - contentX * ratio;
    appView.zoomPanY = mouseY - contentY * ratio;

    // The browser needs a reflow for offsetWidth to reflect the new --zoom-mult
    // Force one by reading it:
    void document.getElementById('zoom-viewport')?.offsetWidth;

    clampPan();
    applyZoomTransform();
  }

  function resetZoom() {
    appView.zoomScale = 1;
    appView.zoomPanX = 0;
    appView.zoomPanY = 0;
    applyZoomTransform();
  }

  function toggleZoomMode(force) {
    const next = typeof force === 'boolean' ? force : !appView.zoomMode;
    appView.zoomMode = next;
    if (!next) {
      resetZoom();
    }
    rerender();
    if (next) toast('info', 'Modo zoom ativado', 'Use scroll/+/− para zoom, arraste para mover. L para sair.');
  }

  /**
   * Attach wheel/touch listeners to calendar content.
   * Clicks now pass through to events/cells — drag is detected only after 5px threshold.
   */
  function attachZoomListeners() {
    if (!appView.zoomMode) return;
    const content = document.getElementById('calendar-content');
    const root = document.getElementById('calendar-root');
    if (!content || !root) return;

    if (content._zoomCleanup) content._zoomCleanup();

    // ── WHEEL ─────────────────────────────────────────────────────────────────
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeLessonHoverCard();
      const factor = e.deltaY < 0 ? (1 + ZOOM_STEP) : (1 / (1 + ZOOM_STEP));
      zoomAtPoint(e.clientX, e.clientY, appView.zoomScale * factor);
    };
    content.addEventListener('wheel', onWheel, { passive: false });

    // ── MOUSE DRAG ─────────────────────────────────────────────────────────────
    // Listen on the root element (not content) so mousedown on any child fires.
    // Use capture=false (bubble) — children that stopPropagation will block,
    // but calendar events deliberately do NOT stopPropagation on mousedown.
    let pointerDown = false;
    let didDrag = false;
    let downX = 0, downY = 0;
    let panStartX = 0, panStartY = 0;
    const DRAG_THRESHOLD = 4;

    const onMouseDown = (e) => {
      // Only left click or middle (scroll wheel) button
      if (e.button !== 0 && e.button !== 1) return;
      pointerDown = true;
      didDrag = false;
      downX = e.clientX;
      downY = e.clientY;
      panStartX = appView.zoomPanX;
      panStartY = appView.zoomPanY;
      // Prevent text selection, image drag, and native HTML5 drag
      e.preventDefault();
      // Middle-click sometimes auto-scrolls — prevent that
      if (e.button === 1) e.stopPropagation();
    };

    const onMouseMove = (e) => {
      if (!pointerDown) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (!didDrag && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        didDrag = true;
        root.classList.add('panning');
        closeLessonHoverCard();
      }
      if (didDrag) {
        appView.zoomPanX = panStartX + dx;
        appView.zoomPanY = panStartY + dy;
        clampPan();
        applyZoomTransform();
      }
    };

    const onMouseUp = () => {
      if (!pointerDown) return;
      const wasDrag = didDrag;
      pointerDown = false;
      didDrag = false;
      root.classList.remove('panning');
      if (wasDrag) {
        // Suppress the click that fires after mouseup to avoid opening modals
        const suppress = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        document.addEventListener('click', suppress, { capture: true, once: true });
      }
    };

    // Attach mousedown on content in CAPTURE phase — fires before any child handler.
    // This prevents interference from draggable="true" children or stopPropagation elsewhere.
    content.addEventListener('mousedown', onMouseDown, { capture: true });
    // Also block auxclick (middle-button "paste" / auto-scroll) while in zoom mode
    const onAuxClick = (e) => { if (e.button === 1) e.preventDefault(); };
    content.addEventListener('auxclick', onAuxClick);
    // Move and up on window so drag works even if mouse leaves content
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // ── TOUCH ──────────────────────────────────────────────────────────────────
    let touchMode = null; // 'pan' | 'pinch'
    let t1X = 0, t1Y = 0;
    let panTouchStartX = 0, panTouchStartY = 0;
    let pinchDist0 = 0, pinchScale0 = 1;
    let pinchCX = 0, pinchCY = 0;
    let touchDidMove = false;

    const dist2 = (t) => Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
    const mid2 = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    const onTouchStart = (e) => {
      touchDidMove = false;
      if (e.touches.length === 1) {
        touchMode = 'pan';
        t1X = e.touches[0].clientX;
        t1Y = e.touches[0].clientY;
        panTouchStartX = appView.zoomPanX;
        panTouchStartY = appView.zoomPanY;
      } else if (e.touches.length >= 2) {
        touchMode = 'pinch';
        pinchDist0 = dist2(e.touches);
        pinchScale0 = appView.zoomScale;
        const c = mid2(e.touches);
        pinchCX = c.x;
        pinchCY = c.y;
        e.preventDefault();
      }
    };

    const onTouchMove = (e) => {
      if (touchMode === 'pan' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - t1X;
        const dy = e.touches[0].clientY - t1Y;
        if (!touchDidMove && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          touchDidMove = true;
          root.classList.add('panning');
        }
        if (touchDidMove) {
          appView.zoomPanX = panTouchStartX + dx;
          appView.zoomPanY = panTouchStartY + dy;
          clampPan();
          applyZoomTransform();
          e.preventDefault();
        }
      } else if (touchMode === 'pinch' && e.touches.length >= 2) {
        const d = dist2(e.touches);
        if (pinchDist0 > 0) {
          // Pinch focal point tracks the midpoint between fingers live
          const c = mid2(e.touches);
          zoomAtPoint(c.x, c.y, pinchScale0 * (d / pinchDist0));
        }
        e.preventDefault();
      }
    };

    const onTouchEnd = (e) => {
      const wasMove = touchDidMove;
      if (e.touches.length === 0) {
        touchMode = null;
        touchDidMove = false;
        root.classList.remove('panning');
        if (wasMove) {
          const suppress = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          document.addEventListener('click', suppress, { capture: true, once: true });
        }
      } else if (e.touches.length === 1 && touchMode === 'pinch') {
        // Pinch → pan transition
        touchMode = 'pan';
        touchDidMove = false;
        t1X = e.touches[0].clientX;
        t1Y = e.touches[0].clientY;
        panTouchStartX = appView.zoomPanX;
        panTouchStartY = appView.zoomPanY;
      }
    };

    content.addEventListener('touchstart', onTouchStart, { passive: false });
    content.addEventListener('touchmove', onTouchMove, { passive: false });
    content.addEventListener('touchend', onTouchEnd);
    content.addEventListener('touchcancel', onTouchEnd);

    // ── CLEANUP ────────────────────────────────────────────────────────────────
    content._zoomCleanup = () => {
      content.removeEventListener('wheel', onWheel);
      content.removeEventListener('mousedown', onMouseDown, { capture: true });
      content.removeEventListener('auxclick', onAuxClick);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      content.removeEventListener('touchstart', onTouchStart);
      content.removeEventListener('touchmove', onTouchMove);
      content.removeEventListener('touchend', onTouchEnd);
      content.removeEventListener('touchcancel', onTouchEnd);
    };
  }

  function bindCalendarEvents() {
    $$('[data-cal-nav]').forEach(b => {
      b.addEventListener('click', () => {
        const dir = b.dataset.calNav;
        if (dir === 'today') { appView.calendarDate = todayStr(); }
        else {
          const step = appView.calendarZoom === 'day' ? 1 : appView.calendarZoom === 'month' ? 30 : 7;
          if (appView.calendarZoom === 'month') {
            const d = parseDate(appView.calendarDate);
            d.setMonth(d.getMonth() + (dir === 'next' ? 1 : -1));
            appView.calendarDate = dateToString(d);
          } else {
            appView.calendarDate = addDays(appView.calendarDate, dir === 'next' ? step : -step);
          }
        }
        rerender();
      });
    });

    $$('[data-zoom]').forEach(b => {
      b.addEventListener('click', () => {
        appView.calendarZoom = b.dataset.zoom;
        rerender();
      });
    });

    $$('[data-interval]').forEach(b => {
      b.addEventListener('click', () => {
        appView.calendarInterval = parseInt(b.dataset.interval, 10);
        rerender();
      });
    });

    const fr = $('#filter-room');
    if (fr) fr.addEventListener('change', () => {
      appView.calendarFilterRoom = fr.value || null;
      rerender();
    });

    const ft = $('#filter-teacher');
    if (ft) ft.addEventListener('change', () => {
      appView.calendarFilterTeacher = ft.value || null;
      rerender();
    });

    const hb = $('#holidays-btn');
    if (hb) hb.addEventListener('click', () => openHolidaysModal());

    const dateLabel = $('#cal-date-label');
    if (dateLabel) dateLabel.addEventListener('click', () => openDateJumpModal());

    const nl = $('#new-lesson-btn');
    if (nl) nl.addEventListener('click', () => openLessonCreateModal());

    // Zoom toggle + controls
    const zoomToggle = $('#zoom-toggle-btn');
    if (zoomToggle) zoomToggle.addEventListener('click', () => toggleZoomMode());

    const zoomIn = $('#zoom-in-btn');
    if (zoomIn) zoomIn.addEventListener('click', () => {
      const content = document.getElementById('calendar-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale * (1 + ZOOM_STEP * 2));
    });
    const zoomOut = $('#zoom-out-btn');
    if (zoomOut) zoomOut.addEventListener('click', () => {
      const content = document.getElementById('calendar-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale / (1 + ZOOM_STEP * 2));
    });
    const zoomReset = $('#zoom-reset-btn');
    if (zoomReset) zoomReset.addEventListener('click', () => { resetZoom(); });

    const zoomExit = $('#zoom-exit-float');
    if (zoomExit) zoomExit.addEventListener('click', () => toggleZoomMode(false));

    // Floating mobile buttons (same behavior as desktop inline controls)
    const zoomFloatIn = $('#zoom-float-in');
    if (zoomFloatIn) zoomFloatIn.addEventListener('click', () => {
      const content = document.getElementById('calendar-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale * (1 + ZOOM_STEP * 2));
    });
    const zoomFloatOut = $('#zoom-float-out');
    if (zoomFloatOut) zoomFloatOut.addEventListener('click', () => {
      const content = document.getElementById('calendar-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale / (1 + ZOOM_STEP * 2));
    });
    const zoomFloatReset = $('#zoom-float-reset');
    if (zoomFloatReset) zoomFloatReset.addEventListener('click', () => { resetZoom(); });

    // Attach zoom listeners if mode is on
    attachZoomListeners();

    // Attach hover tooltips for lesson cards
    attachLessonHoverCards();

    $$('[data-lesson-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openLessonDetailModal(el.dataset.lessonId);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lesson = state.lessons.find(l => l.id === el.dataset.lessonId);
        if (!lesson) return;
        const isScheduled = lesson.status === 'scheduled';
        const isDone = lesson.status === 'done';
        const isCanceled = lesson.status === 'canceled';
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Abrir detalhes', icon: 'info', onClick: () => openLessonDetailModal(lesson.id) },
          { divider: true },
          { label: 'Marcar como concluída', icon: 'check', disabled: isDone, onClick: () => { completeLesson(lesson.id); } },
          { label: 'Cancelar aula', icon: 'close', disabled: isCanceled, onClick: () => openCancelLessonModal(lesson.id) },
          { divider: true },
          { label: 'Duplicar', icon: 'copy', onClick: () => duplicateLesson(lesson.id) },
          { label: 'Enviar lembrete WhatsApp', icon: 'wa', disabled: !isScheduled, onClick: () => sendWhatsAppReminder(lesson.id, lesson.studentIds[0]) },
          { divider: true },
          { label: 'Excluir aula', icon: 'trash', danger: true, onClick: () => confirmDeleteLesson(lesson.id) }
        ]);
      });
      // Drag-and-drop (bloqueado em zoom mode — pan toma conta do drag)
      el.addEventListener('dragstart', (e) => {
        if (appView.zoomMode) {
          e.preventDefault();
          return;
        }
        dragState = { lessonId: el.dataset.lessonId };
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragState = null;
      });
    });

    $$('[data-block-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openBlockEditModal(el.dataset.blockId);
      });
    });

    $$('[data-month-day]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.month-event') && !e.target.closest('.more-link')) return;
        if (e.target.closest('[data-confirm-day]')) return;
        appView.calendarDate = el.dataset.monthDay;
        appView.calendarZoom = 'day';
        rerender();
      });
    });

    $$('[data-confirm-day]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openConfirmDayLessonsModal(b.dataset.confirmDay);
      });
    });

    $$('.hour-cell').forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.cal-event')) return;
        const day = cell.dataset.day;
        const minute = parseInt(cell.dataset.minute, 10);
        openLessonCreateModal({ defaultDate: day, defaultStart: minutesToTime(minute) });
      });
      cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.style.background = 'var(--accent-softer)'; });
      cell.addEventListener('dragleave', () => { cell.style.background = ''; });
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.style.background = '';
        if (!dragState) return;
        const lesson = findById('lessons', dragState.lessonId);
        if (!lesson) return;
        const newDate = cell.dataset.day;
        const newStartMin = parseInt(cell.dataset.minute, 10);
        const duration = timeToMinutes(lesson.end) - timeToMinutes(lesson.start);
        const newEndMin = newStartMin + duration;
        const newStart = minutesToTime(newStartMin);
        const newEnd = minutesToTime(newEndMin);
        const conflict = checkLessonConflict({
          roomId: lesson.roomId, teacherIds: lesson.teacherIds, studentIds: lesson.studentIds,
          date: newDate, start: newStart, end: newEnd, excludeLessonId: lesson.id
        });
        if (conflict) { showError('Conflito ao mover aula', conflict.message); return; }
        lesson.date = newDate;
        lesson.start = newStart;
        lesson.end = newEnd;
        saveState();
        rerender();
        toast('ok', 'Aula movida', `Para ${formatDate(newDate)} às ${newStart}`);
      });
    });
  }

  // =========================================================
  // HOLIDAYS / BLOCK MODALS
  // =========================================================

  function openHolidaysModal() {
    const rerenderList = (node) => {
      const list = node.querySelector('#holiday-list');
      list.innerHTML = state.settings.holidays.length === 0
        ? `<div class="empty-state" style="padding:1.5rem"><p>Nenhum feriado cadastrado.</p></div>`
        : state.settings.holidays.slice().sort((a,b) => a.date.localeCompare(b.date)).map(h => `
          <div class="flex items-center gap-sm" style="padding:8px 4px;border-bottom:1px solid var(--line)">
            <div style="flex:1">
              <div style="font-weight:500">${escapeHtml(h.label)}</div>
              <div class="text-sm text-muted">${formatDate(h.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</div>
            </div>
            <button class="table-action danger" data-rm-holiday="${h.id}">${icon('trash', 14)}</button>
          </div>
        `).join('');
      list.querySelectorAll('[data-rm-holiday]').forEach(b => {
        b.addEventListener('click', () => {
          state.settings.holidays = state.settings.holidays.filter(h => h.id !== b.dataset.rmHoliday);
          saveState();
          rerenderList(node);
        });
      });
    };

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Feriados e dias sem expediente</h3>
          <p class="modal-sub">Datas bloqueadas automaticamente no calendário</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="grid-2 mb-md">
          <div class="field" style="margin-bottom:0">
            <label class="field-label">Data</label>
            <input type="date" class="input" id="h-date" />
          </div>
          <div class="field" style="margin-bottom:0">
            <label class="field-label">Descrição</label>
            <input class="input" id="h-label" placeholder="Ex: Natal" />
          </div>
        </div>
        <button class="btn btn-accent btn-sm" id="h-add">${icon('plus', 14)} Adicionar</button>
        <div class="divider"></div>
        <div id="holiday-list"></div>
      </div>
    `, {
      onMount: (node) => {
        rerenderList(node);
        node.querySelector('#h-add').addEventListener('click', () => {
          const date = node.querySelector('#h-date').value;
          const label = node.querySelector('#h-label').value.trim();
          if (!date || !label) { showError('Dados incompletos', 'Informe a data e a descrição.'); return; }
          state.settings.holidays.push({ id: uid('h'), date, label });
          saveState();
          node.querySelector('#h-date').value = '';
          node.querySelector('#h-label').value = '';
          rerenderList(node);
          toast('ok', 'Feriado adicionado', label);
        });
      }
    });
  }

  // =========================================================
  // DATE JUMP MODAL — quick navigation with year/month/day picker
  // =========================================================

  function openDateJumpModal() {
    const today = todayStr();
    const currentDate = parseDate(appView.calendarDate) || new Date();
    let viewYear = currentDate.getFullYear();
    let viewMonth = currentDate.getMonth();
    let selectedDate = appView.calendarDate;

    const years = [];
    const nowYear = new Date().getFullYear();
    for (let y = nowYear - 5; y <= nowYear + 5; y++) years.push(y);

    const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    const buildGrid = () => {
      const first = new Date(viewYear, viewMonth, 1);
      const firstDow = first.getDay();
      const gridStart = addDays(dateToString(first), -firstDow);
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const dateStr = addDays(gridStart, i);
        const d = parseDate(dateStr);
        cells.push({
          dateStr,
          day: d.getDate(),
          inMonth: d.getMonth() === viewMonth,
          isToday: dateStr === today,
          selected: dateStr === selectedDate
        });
      }
      return cells;
    };

    const isInSelectedWeek = (dateStr) => {
      if (appView.calendarZoom !== 'week') return false;
      const ws = startOfWeek(selectedDate);
      const we = addDays(ws, 6);
      return dateStr >= ws && dateStr <= we;
    };

    const render = () => {
      const cells = buildGrid();
      const dowLabels = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
      return `
        <div class="date-jump-nav">
          <select class="select" id="dj-month">
            ${months.map((m, i) => `<option value="${i}" ${i === viewMonth ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <select class="select" id="dj-year">
            ${years.map(y => `<option value="${y}" ${y === viewYear ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-icon" id="dj-prev" title="Mês anterior">${icon('chev-left', 14)}</button>
          <button class="btn btn-ghost btn-icon" id="dj-next" title="Próximo mês">${icon('chev-right', 14)}</button>
        </div>
        <div class="date-jump-grid">
          ${dowLabels.map(d => `<div class="dow-label">${d}</div>`).join('')}
          ${cells.map(c => `
            <button class="date-jump-cell ${c.inMonth ? '' : 'other-month'} ${c.isToday ? 'today' : ''} ${c.selected ? 'selected' : ''} ${isInSelectedWeek(c.dateStr) && !c.selected ? 'in-week' : ''}" data-jump-to="${c.dateStr}" type="button">${c.day}</button>
          `).join('')}
        </div>
      `;
    };

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Ir para data</h3>
          <p class="modal-sub">Navegue por ano, mês e selecione o dia ou a semana</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="Fechar">${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div id="dj-content">${render()}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="dj-today">Hoje</button>
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="dj-apply">Ir</button>
      </div>
    `, {
      onMount: (node, close) => {
        const content = node.querySelector('#dj-content');

        const bind = () => {
          const monthSelect = node.querySelector('#dj-month');
          const yearSelect = node.querySelector('#dj-year');
          monthSelect?.addEventListener('change', (e) => { viewMonth = parseInt(e.target.value, 10); content.innerHTML = render(); bind(); });
          yearSelect?.addEventListener('change', (e) => { viewYear = parseInt(e.target.value, 10); content.innerHTML = render(); bind(); });
          node.querySelector('#dj-prev')?.addEventListener('click', () => {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            content.innerHTML = render(); bind();
          });
          node.querySelector('#dj-next')?.addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            content.innerHTML = render(); bind();
          });
          node.querySelectorAll('[data-jump-to]').forEach(btn => {
            btn.addEventListener('click', () => {
              selectedDate = btn.dataset.jumpTo;
              content.innerHTML = render();
              bind();
            });
          });
        };
        bind();

        node.querySelector('#dj-today').addEventListener('click', () => {
          selectedDate = today;
          const d = parseDate(today);
          viewYear = d.getFullYear();
          viewMonth = d.getMonth();
          content.innerHTML = render();
          bind();
        });

        node.querySelector('#dj-apply').addEventListener('click', () => {
          appView.calendarDate = selectedDate;
          close();
          rerender();
        });
      }
    });
  }

  function openBlockEditModal(blockId) {
    const block = blockId ? state.blocks.find(b => b.id === blockId) : null;
    const isNew = !block;
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Novo bloqueio' : 'Editar bloqueio'}</h3>
          <p class="modal-sub">Bloqueios impedem agendamentos no horário</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Sala</label>
          <select class="select" id="b-room">
            ${state.rooms.filter(r => r.active).map(r => `<option value="${r.id}" ${block?.roomId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">Data</label>
          <input type="date" class="input" id="b-date" value="${block?.date || todayStr()}" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Início</label>
            <input type="time" class="input" id="b-start" value="${block?.start || '12:00'}" />
          </div>
          <div class="field">
            <label class="field-label">Fim</label>
            <input type="time" class="input" id="b-end" value="${block?.end || '13:00'}" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Descrição</label>
          <input class="input" id="b-label" value="${escapeHtml(block?.label || '')}" placeholder="Ex: Almoço" />
        </div>
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="b-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="b-save">Salvar</button>
      </div>
    `, {
      size: 'sm',
      onMount: (node, close) => {
        node.querySelector('#b-save').addEventListener('click', () => {
          const data = {
            id: block?.id || uid('block'),
            roomId: node.querySelector('#b-room').value,
            date: node.querySelector('#b-date').value,
            start: node.querySelector('#b-start').value,
            end: node.querySelector('#b-end').value,
            label: node.querySelector('#b-label').value.trim() || 'Bloqueio'
          };
          if (!data.roomId || !data.date || !data.start || !data.end) {
            showError('Dados incompletos', 'Preencha todos os campos.'); return;
          }
          if (timeToMinutes(data.start) >= timeToMinutes(data.end)) {
            showError('Horário inválido', 'O horário final deve ser maior que o inicial.'); return;
          }
          if (isNew) state.blocks.push(data);
          else Object.assign(block, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Bloqueio criado' : 'Bloqueio atualizado');
        });
        if (!isNew) {
          node.querySelector('#b-delete').addEventListener('click', () => {
            showConfirm('Excluir bloqueio?', 'Esta ação não pode ser desfeita.', () => {
              state.blocks = state.blocks.filter(b => b.id !== block.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Bloqueio excluído');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  // =========================================================
  // LESSON CREATE MODAL
  // =========================================================

  function openLessonCreateModal(opts = {}) {
    if (state.rooms.filter(r => r.active).length === 0) {
      showError('Sem salas ativas', 'Cadastre pelo menos uma sala ativa antes de criar um agendamento.');
      return;
    }
    if (state.teachers.filter(t => t.active).length === 0) {
      showError('Sem professores ativos', 'Cadastre pelo menos um professor ativo antes de criar um agendamento.');
      return;
    }
    if (state.students.filter(s => s.active).length === 0) {
      showError('Sem alunos ativos', 'Cadastre pelo menos um aluno ativo antes de criar um agendamento.');
      return;
    }

    const defaultDate = opts.defaultDate || todayStr();
    const defaultStart = opts.defaultStart || '13:00';
    const dur = state.settings.lessonDuration || 60;
    const defaultEnd = minutesToTime(timeToMinutes(defaultStart) + dur);

    const html = `
      <div class="modal-header">
        <div style="flex:1">
          <h3>Novo agendamento</h3>
          <p class="modal-sub">Configure a aula ou pacote de aulas</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Modalidade</label>
          <div class="zoom-selector" style="width:100%">
            <button class="active" data-mod="single" style="flex:1">Aula avulsa</button>
            <button data-mod="package" style="flex:1">Pacote (${state.settings.packageSize} aulas)</button>
            <button data-mod="other" style="flex:1">Outros</button>
          </div>
        </div>

        <div class="field">
          <label class="field-label">Sala</label>
          <select class="select" id="l-room">
            ${state.rooms.filter(r => r.active).map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label class="field-label">Professores</label>
          <div id="l-teachers-mount"></div>
        </div>

        <div class="field">
          <label class="field-label">Alunos</label>
          <div id="l-students-mount"></div>
        </div>

        <div class="grid-3">
          <div class="field">
            <label class="field-label">Data</label>
            <input type="date" class="input" id="l-date" value="${defaultDate}" />
          </div>
          <div class="field">
            <label class="field-label">Início</label>
            <input type="time" class="input" id="l-start" value="${defaultStart}" />
          </div>
          <div class="field">
            <label class="field-label">Fim</label>
            <input type="time" class="input" id="l-end" value="${defaultEnd}" />
          </div>
        </div>

        <div id="l-other-fields" style="display:none">
          <div class="field">
            <label class="field-label">Grupo (opcional)</label>
            <select class="select" id="l-group">
              <option value="">Sem grupo — selecione alunos individualmente</option>
              ${state.groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.studentIds.length} alunos)</option>`).join('')}
            </select>
            <div id="l-group-preview"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label">Quantidade de aulas</label>
              <input type="number" class="input" id="l-count" value="2" min="1" max="50" />
            </div>
            <div class="field">
              <label class="field-label">Distribuição</label>
              <select class="select" id="l-distribution">
                <option value="weekly">Semanal (mesmo horário)</option>
                <option value="sequential">Sequencial (mesmo dia)</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label class="field-label">Valor total da sessão</label>
            <input type="number" class="input" id="l-total-price" value="" step="0.01" placeholder="0,00" />
          </div>
          <div class="field">
            <label class="field-label">Divisão do valor</label>
            <div class="zoom-selector">
              <button class="active" data-split="equal">Igual entre alunos</button>
              <button data-split="individual">Valor individual</button>
            </div>
          </div>
          <div id="l-individual-prices" style="display:none;margin-top:8px"></div>
        </div>

        <div id="l-package-fields" style="display:none">
          <div class="field">
            <label class="field-label">Distribuição</label>
            <select class="select" id="l-pkg-distribution">
              <option value="weekly">Semanal (próximas ${state.settings.packageSize} semanas)</option>
              <option value="sequential">Sequencial (mesmo dia)</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label class="field-label">Observações (opcional)</label>
          <textarea class="textarea" id="l-notes" placeholder="Detalhes adicionais..."></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-accent" id="l-save">Agendar</button>
      </div>
    `;

    openModal(html, {
      size: 'lg',
      onMount: (node, close) => {
        let modality = 'single';
        let splitMode = 'equal';

        // Teacher multi-select
        const teacherSelected = [];
        mountMultiSelect(node.querySelector('#l-teachers-mount'),
          state.teachers.filter(t => t.active).map(t => ({ id: t.id, label: t.name })),
          teacherSelected,
          'Buscar professores...'
        );

        // Student multi-select — excludes students already in the selected group
        const studentSelected = [];
        let selectedGroupId = '';

        const rebuildStudentMulti = () => {
          const group = selectedGroupId ? state.groups.find(g => g.id === selectedGroupId) : null;
          const excludeIds = group ? new Set(group.studentIds) : new Set();
          // Remove any previously-selected students that are now in the group
          for (let i = studentSelected.length - 1; i >= 0; i--) {
            if (excludeIds.has(studentSelected[i])) studentSelected.splice(i, 1);
          }
          const opts = state.students.filter(s => s.active && !excludeIds.has(s.id)).map(s => {
            const st = getStudentLessonStatus(s);
            // Show as "Nome (feitas/total) · disponível X"
            const label = `${s.name} (${st.used}/${st.total}) · ${st.available} disponível(is)`;
            return { id: s.id, label, disabled: st.available <= 0 && modality !== 'other' };
          });
          mountMultiSelect(node.querySelector('#l-students-mount'),
            opts, studentSelected, 'Buscar alunos...', () => renderIndividualPrices()
          );
        };

        rebuildStudentMulti();

        const renderGroupPreview = () => {
          const preview = node.querySelector('#l-group-preview');
          if (!preview) return;
          if (!selectedGroupId) { preview.innerHTML = ''; return; }
          const group = state.groups.find(g => g.id === selectedGroupId);
          if (!group) { preview.innerHTML = ''; return; }
          const members = group.studentIds.map(id => findById('students', id)).filter(Boolean);
          if (members.length === 0) {
            preview.innerHTML = `<div class="group-preview"><div class="group-preview-header">${icon('users', 14)} Grupo "${escapeHtml(group.name)}" está vazio</div></div>`;
            return;
          }
          preview.innerHTML = `
            <div class="group-preview">
              <div class="group-preview-header">${icon('users', 14)} ${members.length} aluno(s) no grupo "${escapeHtml(group.name)}"</div>
              <div class="group-preview-members">
                ${members.map(m => {
                  const c = m.color || DEFAULT_COLORS[2];
                  return `<span class="group-preview-member"><span class="avatar" style="background:${c}">${escapeHtml(initials(m.name))}</span>${escapeHtml(m.name)}</span>`;
                }).join('')}
              </div>
            </div>
          `;
        };

        const groupSelect = node.querySelector('#l-group');
        if (groupSelect) {
          groupSelect.addEventListener('change', (e) => {
            selectedGroupId = e.target.value;
            renderGroupPreview();
            rebuildStudentMulti();
            renderIndividualPrices();
          });
        }

        // Auto-update end based on modality + distribution
        const autoUpdateEnd = () => {
          const startInput = node.querySelector('#l-start');
          const endInput = node.querySelector('#l-end');
          if (!startInput || !endInput) return;
          const s = timeToMinutes(startInput.value);
          const duration = state.settings.lessonDuration || 60;

          // Determine count and distribution based on modality
          let count = 1;
          let dist = 'weekly';
          if (modality === 'package') {
            count = state.settings.packageSize || 4;
            const pkgSel = node.querySelector('#l-pkg-distribution');
            dist = pkgSel ? pkgSel.value : 'weekly';
          } else if (modality === 'other') {
            const cEl = node.querySelector('#l-count');
            count = cEl ? parseInt(cEl.value, 10) || 1 : 1;
            const dEl = node.querySelector('#l-distribution');
            dist = dEl ? dEl.value : 'weekly';
          }

          // For sequential: end = start + duration * count (block of lessons)
          // For weekly / single: end = start + duration (single slot)
          const totalMin = dist === 'sequential' ? duration * count : duration;
          endInput.value = minutesToTime(s + totalMin);
        };

        // Modality buttons
        node.querySelectorAll('[data-mod]').forEach(b => {
          b.addEventListener('click', () => {
            node.querySelectorAll('[data-mod]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            modality = b.dataset.mod;
            node.querySelector('#l-other-fields').style.display = modality === 'other' ? '' : 'none';
            node.querySelector('#l-package-fields').style.display = modality === 'package' ? '' : 'none';
            autoUpdateEnd();
          });
        });

        // Split mode
        node.querySelectorAll('[data-split]').forEach(b => {
          b.addEventListener('click', () => {
            node.querySelectorAll('[data-split]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            splitMode = b.dataset.split;
            node.querySelector('#l-individual-prices').style.display = splitMode === 'individual' ? '' : 'none';
            renderIndividualPrices();
          });
        });

        // Start time change
        node.querySelector('#l-start').addEventListener('change', autoUpdateEnd);
        // Distribution change (package)
        node.querySelector('#l-pkg-distribution')?.addEventListener('change', autoUpdateEnd);
        // Distribution change (other)
        node.querySelector('#l-distribution')?.addEventListener('change', autoUpdateEnd);
        // Count change (other)
        node.querySelector('#l-count')?.addEventListener('input', autoUpdateEnd);

        function renderIndividualPrices() {
          const wrap = node.querySelector('#l-individual-prices');
          if (!wrap) return;
          if (splitMode !== 'individual') return;
          // Combine individually selected + group members
          let allIds = [...studentSelected];
          if (selectedGroupId) {
            const group = state.groups.find(g => g.id === selectedGroupId);
            if (group) group.studentIds.forEach(id => { if (!allIds.includes(id)) allIds.push(id); });
          }
          wrap.innerHTML = allIds.map(id => {
            const s = findById('students', id);
            return `
              <div class="flex items-center gap-sm mb-sm">
                <div style="flex:1;font-size:.9rem">${escapeHtml(s?.name || '')}</div>
                <input type="number" class="input" data-ind-price="${id}" style="max-width:140px" step="0.01" placeholder="Valor" />
              </div>
            `;
          }).join('');
        }

        node.querySelector('#l-save').addEventListener('click', () => {
          const roomId = node.querySelector('#l-room').value;
          const date = node.querySelector('#l-date').value;
          const start = node.querySelector('#l-start').value;
          const end = node.querySelector('#l-end').value;
          const notes = node.querySelector('#l-notes').value.trim();

          if (!roomId || !date || !start || !end) {
            showError('Dados incompletos', 'Preencha sala, data e horários.'); return;
          }
          if (teacherSelected.length === 0) {
            showError('Sem professores', 'Selecione ao menos um professor.'); return;
          }
          // Merge group members (if modality is 'other' and a group is selected) with individual selection
          let finalStudentIds = [...studentSelected];
          if (modality === 'other' && selectedGroupId) {
            const group = state.groups.find(g => g.id === selectedGroupId);
            if (group) {
              group.studentIds.forEach(id => {
                if (!finalStudentIds.includes(id)) finalStudentIds.push(id);
              });
            }
          }
          if (finalStudentIds.length === 0) {
            showError('Sem alunos', 'Selecione ao menos um aluno ou um grupo com alunos.'); return;
          }
          if (timeToMinutes(start) >= timeToMinutes(end)) {
            showError('Horário inválido', 'O horário final deve ser maior que o inicial.'); return;
          }

          // Generate dates based on modality
          const datesList = [];
          const lessonDur = state.settings.lessonDuration || 60;
          if (modality === 'single') {
            datesList.push({ date, start, end });
          } else if (modality === 'package') {
            const count = state.settings.packageSize;
            const dist = node.querySelector('#l-pkg-distribution').value;
            for (let i = 0; i < count; i++) {
              if (dist === 'weekly') {
                datesList.push({ date: addDays(date, i * 7), start, end });
              } else {
                // Sequential: each lesson uses lessonDuration, back-to-back
                const s = timeToMinutes(start) + i * lessonDur;
                const e = s + lessonDur;
                datesList.push({ date, start: minutesToTime(s), end: minutesToTime(e) });
              }
            }
          } else if (modality === 'other') {
            const count = parseInt(node.querySelector('#l-count').value, 10) || 1;
            const dist = node.querySelector('#l-distribution').value;
            for (let i = 0; i < count; i++) {
              if (dist === 'weekly') {
                datesList.push({ date: addDays(date, i * 7), start, end });
              } else {
                const s = timeToMinutes(start) + i * lessonDur;
                const e = s + lessonDur;
                datesList.push({ date, start: minutesToTime(s), end: minutesToTime(e) });
              }
            }
          }

          // Room capacity check
          const capErr = checkRoomCapacity(roomId, finalStudentIds);
          if (capErr) { showError('Capacidade excedida', capErr.message); return; }

          // Validate all dates
          for (const d of datesList) {
            const conflict = checkLessonConflict({
              roomId, teacherIds: teacherSelected, studentIds: finalStudentIds,
              date: d.date, start: d.start, end: d.end
            });
            if (conflict) {
              showError(`Conflito em ${formatDate(d.date)} (${d.start})`, conflict.message);
              return;
            }
          }

          // Student balance check (skip for 'other' modality — explicit)
          if (modality !== 'other') {
            for (const sId of finalStudentIds) {
              const bc = checkStudentBalance(sId, datesList.length);
              if (bc) { showError('Saldo insuficiente', bc.message); return; }
            }
          }

          // Pricing for 'other'
          let pricingData = {};
          if (modality === 'other') {
            const totalPrice = parseFloat(node.querySelector('#l-total-price').value) || 0;
            pricingData.totalPrice = totalPrice;
            if (splitMode === 'equal') {
              const per = finalStudentIds.length > 0 ? totalPrice / finalStudentIds.length : 0;
              pricingData.pricePerStudent = per;
              pricingData.splitMode = 'equal';
            } else {
              pricingData.individualPrices = {};
              node.querySelectorAll('[data-ind-price]').forEach(inp => {
                pricingData.individualPrices[inp.dataset.indPrice] = parseFloat(inp.value) || 0;
              });
              pricingData.splitMode = 'individual';
            }
            pricingData.groupId = selectedGroupId || null;
          }

          // Create lessons
          const packageGroupId = datesList.length > 1 ? uid('pkg') : null;
          datesList.forEach((d, idx) => {
            const lesson = {
              id: uid('l'),
              roomId,
              teacherIds: [...teacherSelected],
              studentIds: [...finalStudentIds],
              date: d.date,
              start: d.start,
              end: d.end,
              status: 'scheduled',
              modality,
              packageGroupId,
              sequenceIndex: idx,
              notes,
              cancelReason: null,
              needsReplacement: false,
              replacementOf: null,
              createdAt: Date.now(),
              ...pricingData
            };
            state.lessons.push(lesson);
          });

          saveState();
          close();
          rerender();
          toast('ok', 'Agendamento criado', `${datesList.length} aula(s) agendada(s)`);
        });
      }
    });
  }

  // =========================================================
  // COLOR PICKER (reusable component)
  // =========================================================

  /**
   * Mounts a color selector with preset swatches + a "custom color" swatch
   * that opens a popover with hue slider, saturation/lightness pad, and hex input.
   * @param {HTMLElement} container - where to render the swatches
   * @param {string} currentColor - currently selected color
   * @param {(color: string) => void} onChange - fired when color changes
   */
  function mountColorPicker(container, currentColor, onChange) {
    const isPreset = DEFAULT_COLORS.includes(currentColor);
    let selectedColor = currentColor || DEFAULT_COLORS[0];
    let customColor = isPreset ? null : currentColor;

    const render = () => {
      container.innerHTML = `
        <div class="color-swatches" style="position:relative">
          ${DEFAULT_COLORS.map(c => `
            <div class="color-swatch ${selectedColor === c ? 'selected' : ''}" style="background:${c}" data-preset-color="${c}"></div>
          `).join('')}
          <div class="color-custom-swatch ${customColor ? 'has-custom' : ''} ${customColor && selectedColor === customColor ? 'selected' : ''}"
            id="custom-color-swatch"
            style="${customColor ? `--custom-color:${customColor};background:${customColor};border-color:${selectedColor === customColor ? 'var(--ink)' : 'var(--line-strong)'}` : ''}"
            title="Cor personalizada"></div>
        </div>
      `;

      container.querySelectorAll('[data-preset-color]').forEach(sw => {
        sw.addEventListener('click', () => {
          selectedColor = sw.dataset.presetColor;
          render();
          onChange(selectedColor);
        });
      });

      const customSwatch = container.querySelector('#custom-color-swatch');
      if (customSwatch) {
        customSwatch.addEventListener('click', (e) => {
          e.stopPropagation();
          openColorPopover(customSwatch, customColor || '#808080', (newColor) => {
            customColor = newColor;
            selectedColor = newColor;
            render();
            onChange(selectedColor);
          });
        });
      }
    };
    render();
  }

  function openColorPopover(anchorEl, initialColor, onPick) {
    // Remove any existing popover
    document.querySelectorAll('.color-picker-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'color-picker-popover';
    popover.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);background:${initialColor};border:1px solid var(--line-strong)" id="cp-preview"></div>
        <div style="flex:1">
          <label style="font-size:.72rem;color:var(--ink-muted);display:block;margin-bottom:2px">Hex</label>
          <input class="input hex-input" id="cp-hex" value="${initialColor.toUpperCase()}" maxlength="7" />
        </div>
      </div>
      <label style="font-size:.72rem;color:var(--ink-muted);display:block;margin-bottom:4px">Matiz</label>
      <input type="range" min="0" max="360" value="${hexToHue(initialColor)}" class="hue-slider-input" id="cp-hue" style="width:100%" />
      <div class="grid-2" style="gap:6px;margin-top:6px">
        <div>
          <label style="font-size:.72rem;color:var(--ink-muted);display:block;margin-bottom:2px">Saturação</label>
          <input type="range" min="0" max="100" value="${hexToSat(initialColor)}" id="cp-sat" style="width:100%" />
        </div>
        <div>
          <label style="font-size:.72rem;color:var(--ink-muted);display:block;margin-bottom:2px">Luminosidade</label>
          <input type="range" min="0" max="100" value="${hexToLight(initialColor)}" id="cp-light" style="width:100%" />
        </div>
      </div>
      <div class="flex gap-sm mt-md">
        <button class="btn btn-ghost btn-sm btn-block" id="cp-cancel">Cancelar</button>
        <button class="btn btn-primary btn-sm btn-block" id="cp-apply">Aplicar</button>
      </div>
    `;
    document.body.appendChild(popover);

    // Position near anchor
    const rect = anchorEl.getBoundingClientRect();
    const popW = 240;
    let left = rect.left + window.scrollX;
    if (left + popW > window.innerWidth - 10) left = window.innerWidth - popW - 10;
    let top = rect.bottom + window.scrollY + 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const hueInput = popover.querySelector('#cp-hue');
    const satInput = popover.querySelector('#cp-sat');
    const lightInput = popover.querySelector('#cp-light');
    const hexInput = popover.querySelector('#cp-hex');
    const preview = popover.querySelector('#cp-preview');

    let currentHex = initialColor;

    const updateFromHSL = () => {
      const h = parseInt(hueInput.value, 10);
      const s = parseInt(satInput.value, 10);
      const l = parseInt(lightInput.value, 10);
      currentHex = hslToHex(h, s, l);
      preview.style.background = currentHex;
      hexInput.value = currentHex.toUpperCase();
    };

    const updateFromHex = () => {
      let v = hexInput.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
        currentHex = v;
        preview.style.background = currentHex;
        hueInput.value = hexToHue(currentHex);
        satInput.value = hexToSat(currentHex);
        lightInput.value = hexToLight(currentHex);
      }
    };

    [hueInput, satInput, lightInput].forEach(inp => inp.addEventListener('input', updateFromHSL));
    hexInput.addEventListener('input', updateFromHex);
    hexInput.addEventListener('blur', updateFromHex);

    const close = () => popover.remove();
    popover.querySelector('#cp-cancel').addEventListener('click', close);
    popover.querySelector('#cp-apply').addEventListener('click', () => {
      onPick(currentHex);
      close();
    });

    // Close when clicking outside
    setTimeout(() => {
      const outside = (e) => {
        if (!popover.contains(e.target) && e.target !== anchorEl) {
          close();
          document.removeEventListener('click', outside);
        }
      };
      document.addEventListener('click', outside);
    }, 0);
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(color * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function hexToHsl(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return { h: 0, s: 0, l: 50 };
    let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hexToHue(hex) { return hexToHsl(hex).h; }
  function hexToSat(hex) { return hexToHsl(hex).s; }
  function hexToLight(hex) { return hexToHsl(hex).l; }

  // =========================================================
  // MULTI-SELECT COMPONENT
  // =========================================================

  function mountMultiSelect(container, options, selectedArr, placeholder, onChange) {
    const render = () => {
      container.innerHTML = `
        <div class="multi-select">
          ${selectedArr.map(id => {
            const opt = options.find(o => o.id === id);
            if (!opt) return '';
            return `<span class="multi-select-item">
              <span>${escapeHtml(opt.label)}</span>
              <span class="remove" data-ms-remove="${id}">${icon('close', 12)}</span>
            </span>`;
          }).join('')}
          <input class="multi-select-search" placeholder="${escapeHtml(placeholder)}" />
        </div>
        <div class="multi-select-dropdown" style="display:none"></div>
      `;

      const searchInput = container.querySelector('.multi-select-search');
      const dropdown = container.querySelector('.multi-select-dropdown');

      const renderDropdown = () => {
        const q = searchInput.value.toLowerCase();
        const filtered = options.filter(o => o.label.toLowerCase().includes(q));
        if (filtered.length === 0) {
          dropdown.innerHTML = `<div class="multi-select-empty">Nenhum resultado</div>`;
        } else {
          dropdown.innerHTML = filtered.map(o => {
            const isSelected = selectedArr.includes(o.id);
            return `<div class="multi-select-option ${isSelected ? 'selected' : ''}" data-ms-opt="${o.id}" ${o.disabled ? 'style="opacity:.5;pointer-events:none"' : ''}>${escapeHtml(o.label)}</div>`;
          }).join('');
          dropdown.querySelectorAll('[data-ms-opt]').forEach(item => {
            item.addEventListener('mousedown', (e) => {
              e.preventDefault();
              const id = item.dataset.msOpt;
              const idx = selectedArr.indexOf(id);
              if (idx >= 0) selectedArr.splice(idx, 1);
              else selectedArr.push(id);
              searchInput.value = '';
              render();
              searchInput.focus();
              if (onChange) onChange();
            });
          });
        }
      };

      searchInput.addEventListener('focus', () => {
        dropdown.style.display = '';
        renderDropdown();
      });
      searchInput.addEventListener('blur', () => {
        setTimeout(() => { dropdown.style.display = 'none'; }, 200);
      });
      searchInput.addEventListener('input', renderDropdown);

      container.querySelectorAll('[data-ms-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.msRemove;
          const idx = selectedArr.indexOf(id);
          if (idx >= 0) selectedArr.splice(idx, 1);
          render();
          if (onChange) onChange();
        });
      });
    };
    render();
    return { rerender: render };
  }

  // =========================================================
  // LESSON DETAIL MODAL
  // =========================================================

  function openLessonDetailModal(lessonId) {
    const lesson = findById('lessons', lessonId);
    if (!lesson) return;
    const room = findById('rooms', lesson.roomId);
    const teachers = lesson.teacherIds.map(id => findById('teachers', id)).filter(Boolean);
    const students = lesson.studentIds.map(id => findById('students', id)).filter(Boolean);

    const cancelPresets = ['Falta do aluno', 'Falta do professor', 'Cancelamento da empresa', 'Reagendamento'];

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Detalhes da aula</h3>
          <p class="modal-sub">${formatDate(lesson.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${lesson.start} — ${lesson.end}</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="flex gap-sm mb-md flex-wrap">
          ${lesson.status === 'done' ? '<span class="badge badge-ok badge-dot">Concluída</span>' :
            lesson.status === 'canceled' ? '<span class="badge badge-danger badge-dot">Cancelada</span>' :
            '<span class="badge badge-neutral badge-dot">Agendada</span>'}
          <span class="badge badge-accent">${lesson.modality === 'single' ? 'Aula avulsa' : lesson.modality === 'package' ? 'Pacote' : 'Outros'}</span>
          ${lesson.replacementOf ? '<span class="badge badge-info">Reposição</span>' : ''}
          ${lesson.needsReplacement ? '<span class="badge badge-warn">Precisa de reposição</span>' : ''}
        </div>

        <div class="card" style="padding:12px;margin-bottom:10px">
          <div class="text-xs text-muted mb-sm" style="text-transform:uppercase;letter-spacing:.05em">Sala</div>
          <div class="flex items-center gap-sm">
            <div class="entity-color-dot" style="background:${room?.color || '#ccc'}"></div>
            <strong>${escapeHtml(room?.name || '—')}</strong>
          </div>
        </div>

        <div class="card" style="padding:12px;margin-bottom:10px">
          <div class="text-xs text-muted mb-sm" style="text-transform:uppercase;letter-spacing:.05em">Professores</div>
          ${teachers.length === 0 ? '<em>Nenhum</em>' : teachers.map(t => `
            <div class="flex items-center gap-sm" style="padding:3px 0">
              <div class="entity-color-dot" style="background:${t.color}"></div>
              <span>${escapeHtml(t.name)}</span>
              <span class="text-muted text-sm">· ${escapeHtml(t.specialty || '')}</span>
            </div>
          `).join('')}
        </div>

        <div class="card" style="padding:12px;margin-bottom:10px">
          <div class="text-xs text-muted mb-sm" style="text-transform:uppercase;letter-spacing:.05em">Alunos</div>
          ${students.map(s => {
            const st = getStudentLessonStatus(s);
            return `
            <div class="flex items-center gap-sm" style="padding:3px 0">
              <div class="avatar" style="width:24px;height:24px;font-size:.72rem">${escapeHtml(initials(s.name))}</div>
              <span style="flex:1">${escapeHtml(s.name)}</span>
              <span class="lesson-count lc-${st.color}" style="font-size:.72rem">${st.used}/${st.total}</span>
            </div>`;
          }).join('')}
        </div>

        ${lesson.notes ? `
          <div class="card" style="padding:12px;margin-bottom:10px">
            <div class="text-xs text-muted mb-sm" style="text-transform:uppercase;letter-spacing:.05em">Observações</div>
            <div>${escapeHtml(lesson.notes)}</div>
          </div>
        ` : ''}

        ${lesson.cancelReason ? `
          <div class="card" style="padding:12px;margin-bottom:10px;background:var(--danger-soft);border-color:var(--danger-soft)">
            <div class="text-xs mb-sm" style="text-transform:uppercase;letter-spacing:.05em;color:var(--danger-ink)">Motivo do cancelamento</div>
            <div style="color:var(--danger-ink)">${escapeHtml(lesson.cancelReason)}</div>
          </div>
        ` : ''}

        ${lesson.totalPrice ? `
          <div class="card" style="padding:12px">
            <div class="text-xs text-muted mb-sm" style="text-transform:uppercase;letter-spacing:.05em">Valores</div>
            <div class="flex justify-between"><span>Total:</span> <strong>${formatCurrency(lesson.totalPrice)}</strong></div>
            ${lesson.pricePerStudent ? `<div class="flex justify-between"><span>Por aluno (igual):</span> <strong>${formatCurrency(lesson.pricePerStudent)}</strong></div>` : ''}
          </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="l-delete">${icon('trash', 14)} Excluir</button>
        <div class="spacer"></div>
        ${lesson.status === 'scheduled' ? `
          <button class="btn btn-ghost" id="l-cancel">Cancelar aula</button>
          <button class="btn btn-primary" id="l-done">${icon('check', 14)} Concluir</button>
        ` : `
          <button class="btn btn-ghost" id="l-reopen">Reabrir</button>
        `}
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {
        node.querySelector('#l-delete')?.addEventListener('click', () => {
          showConfirm('Excluir aula?', 'Esta ação não pode ser desfeita.', () => {
            state.lessons = state.lessons.filter(l => l.id !== lesson.id);
            saveState();
            close();
            rerender();
            toast('ok', 'Aula excluída');
          }, 'Excluir', 'danger');
        });

        node.querySelector('#l-done')?.addEventListener('click', () => {
          lesson.status = 'done';
          // Increment lessons completed for each student
          lesson.studentIds.forEach(sId => {
            const s = findById('students', sId);
            if (s && !lesson.isReplacement) s.lessonsCompleted = (s.lessonsCompleted || 0) + 1;
          });
          // Check if any student now at critical level
          lesson.studentIds.forEach(sId => {
            const s = findById('students', sId);
            if (!s) return;
            const st = getStudentLessonStatus(s);
            if (st.remaining <= state.settings.packageEndThreshold) {
              pushNotification('warn', 'Pacote quase no fim', `${s.name} tem ${st.remaining} aula(s) restante(s).`);
            }
          });
          saveState();
          close();
          rerender();
          toast('ok', 'Aula concluída');
        });

        node.querySelector('#l-reopen')?.addEventListener('click', () => {
          if (lesson.status === 'done' && !lesson.isReplacement) {
            lesson.studentIds.forEach(sId => {
              const s = findById('students', sId);
              if (s && s.lessonsCompleted > 0) s.lessonsCompleted -= 1;
            });
          }
          lesson.status = 'scheduled';
          lesson.cancelReason = null;
          lesson.needsReplacement = false;
          saveState();
          close();
          rerender();
          toast('ok', 'Aula reaberta');
        });

        node.querySelector('#l-cancel')?.addEventListener('click', () => {
          openCancelLessonModal(lesson, cancelPresets, close);
        });
      }
    });
  }

  function openCancelLessonModal(lesson, presets, parentClose) {
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Cancelar aula</h3>
          <p class="modal-sub">Informe o motivo e se haverá reposição</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Motivo (selecione ou digite)</label>
          <div class="day-chips mb-md">
            ${presets.map(p => `<button class="day-chip" data-preset="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
          </div>
          <input class="input" id="c-reason" placeholder="Escreva um motivo personalizado..." />
        </div>
        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Será reposta?</div>
            <div class="desc">Se marcada, aparecerá na lista de reposições. Caso contrário, a aula é descartada do pacote.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="c-repose" checked />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Voltar</button>
        <button class="btn btn-danger" id="c-confirm">Cancelar aula</button>
      </div>
    `, {
      size: 'sm',
      onMount: (node, close) => {
        node.querySelectorAll('[data-preset]').forEach(b => {
          b.addEventListener('click', () => {
            node.querySelector('#c-reason').value = b.dataset.preset;
            node.querySelectorAll('[data-preset]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
          });
        });
        node.querySelector('#c-confirm').addEventListener('click', () => {
          const reason = node.querySelector('#c-reason').value.trim() || 'Cancelada';
          const repose = node.querySelector('#c-repose').checked;
          lesson.status = 'canceled';
          lesson.cancelReason = reason;
          lesson.needsReplacement = repose;
          saveState();
          close();
          if (parentClose) parentClose();
          rerender();
          toast('warn', 'Aula cancelada', repose ? 'Marcada para reposição' : 'Descartada do pacote');
        });
      }
    });
  }

  // =========================================================
  // CONFIRM DAY LESSONS MODAL — select which lessons of the day to mark as done
  // =========================================================

  function completeLessons(lessons) {
    lessons.forEach(lesson => {
      if (lesson.status !== 'scheduled') return;
      lesson.status = 'done';
      lesson.studentIds.forEach(sId => {
        const s = findById('students', sId);
        if (s && !lesson.isReplacement) s.lessonsCompleted = (s.lessonsCompleted || 0) + 1;
      });
      // Notify critical
      lesson.studentIds.forEach(sId => {
        const s = findById('students', sId);
        if (!s) return;
        const st = getStudentLessonStatus(s);
        if (st.remaining <= state.settings.packageEndThreshold) {
          pushNotification('warn', 'Pacote quase no fim', `${s.name} tem ${st.remaining} aula(s) restante(s).`);
        }
      });
    });
    saveState();
  }

  function completeLesson(lessonId) {
    const lesson = state.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    completeLessons([lesson]);
    rerender();
    toast('ok', 'Aula marcada como concluída');
  }

  function duplicateLesson(lessonId) {
    const lesson = state.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    const next = addDays(lesson.date, 7);
    const copy = {
      ...lesson,
      id: uid('l'),
      date: next,
      status: 'scheduled',
      createdAt: Date.now()
    };
    delete copy.packageGroupId;
    state.lessons.push(copy);
    saveState();
    rerender();
    toast('ok', 'Aula duplicada', `Mesma aula no próximo ${formatDate(next, { weekday: 'long' })}`);
  }

  function confirmDeleteLesson(lessonId) {
    const lesson = state.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    showConfirm('Excluir aula?', `Aula de ${formatDate(lesson.date)} às ${lesson.start}. Esta ação não pode ser desfeita.`, () => {
      state.lessons = state.lessons.filter(l => l.id !== lessonId);
      saveState();
      rerender();
      toast('ok', 'Aula excluída');
    }, 'Excluir', 'danger');
  }

  function openConfirmDayLessonsModal(dateStr) {
    const dayLessons = state.lessons
      .filter(l => l.date === dateStr && l.status === 'scheduled')
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

    if (dayLessons.length === 0) {
      toast('info', 'Sem aulas para confirmar', `Não há aulas agendadas em ${formatDate(dateStr)}`);
      return;
    }

    const selected = new Set(dayLessons.map(l => l.id)); // default: all selected

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Confirmar aulas do dia</h3>
          <p class="modal-sub">${formatDate(dateStr, { weekday: 'long', day: 'numeric', month: 'long' })} · ${dayLessons.length} aula(s) agendada(s)</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="Fechar">${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="flex justify-between mb-sm">
          <button class="btn btn-ghost btn-sm" id="select-all">Selecionar todas</button>
          <button class="btn btn-ghost btn-sm" id="select-none">Nenhuma</button>
        </div>
        <div class="seq-confirm-list" id="confirm-list">
          ${dayLessons.map(l => {
            const room = findById('rooms', l.roomId);
            const teachers = l.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
            const students = l.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
            return `
              <div class="seq-confirm-item selected" data-seq-id="${l.id}">
                <div class="check-indicator">${icon('check', 12)}</div>
                <div class="seq-confirm-info">
                  <div class="label">${l.start} — ${l.end} · ${escapeHtml(students)}</div>
                  <div class="sub">${escapeHtml(teachers)} · ${escapeHtml(room?.name || '')}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="confirm-selected">Confirmar <span id="sel-count">${dayLessons.length}</span> aula(s)</button>
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {
        const items = node.querySelectorAll('[data-seq-id]');
        const updateCount = () => {
          const countEl = node.querySelector('#sel-count');
          if (countEl) countEl.textContent = selected.size;
          const confirmBtn = node.querySelector('#confirm-selected');
          confirmBtn.disabled = selected.size === 0;
          confirmBtn.style.opacity = selected.size === 0 ? '0.5' : '1';
        };

        items.forEach(item => {
          item.addEventListener('click', () => {
            const id = item.dataset.seqId;
            if (selected.has(id)) {
              selected.delete(id);
              item.classList.remove('selected');
            } else {
              selected.add(id);
              item.classList.add('selected');
            }
            updateCount();
          });
        });

        node.querySelector('#select-all').addEventListener('click', () => {
          items.forEach(item => { selected.add(item.dataset.seqId); item.classList.add('selected'); });
          updateCount();
        });
        node.querySelector('#select-none').addEventListener('click', () => {
          items.forEach(item => { selected.delete(item.dataset.seqId); item.classList.remove('selected'); });
          updateCount();
        });

        node.querySelector('#confirm-selected').addEventListener('click', () => {
          if (selected.size === 0) return;
          const toComplete = dayLessons.filter(l => selected.has(l.id));
          completeLessons(toComplete);
          close();
          rerender();
          toast('ok', `${toComplete.length} aula(s) confirmada(s)`, formatDate(dateStr));
        });
      }
    });
  }

  // =========================================================
  // ROOMS VIEW
  // =========================================================

  function renderRooms() {
    const filter = appView.filters.rooms;
    const view = appView.viewModes.rooms;
    const rooms = state.rooms.filter(r => {
      if (filter.status === 'active' && !r.active) return false;
      if (filter.status === 'inactive' && r.active) return false;
      if (filter.search && !r.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      return true;
    });

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Salas</h2>
          <div class="section-sub">${rooms.length} sala(s) · ${state.rooms.filter(r => r.active).length} ativa(s)</div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <div class="view-toggle">
            <button class="${view === 'list' ? 'active' : ''}" data-rview="list">${icon('list', 14)} Lista</button>
            <button class="${view === 'grid' ? 'active' : ''}" data-rview="grid">${icon('grid', 14)} Blocos</button>
          </div>
          <button class="btn btn-accent" id="new-room">${icon('plus', 14)} Nova sala</button>
        </div>
      </div>

      <div class="flex gap-sm mb-md flex-wrap items-center">
        <div class="chip-filters">
          <button class="chip ${filter.status === 'all' ? 'active' : ''}" data-rstatus="all">Todas <span class="count">${state.rooms.length}</span></button>
          <button class="chip ${filter.status === 'active' ? 'active' : ''}" data-rstatus="active">Ativas <span class="count">${state.rooms.filter(r => r.active).length}</span></button>
          <button class="chip ${filter.status === 'inactive' ? 'active' : ''}" data-rstatus="inactive">Inativas <span class="count">${state.rooms.filter(r => !r.active).length}</span></button>
        </div>
        <div style="flex:1"></div>
        <div class="search-global" style="max-width:280px">
          <span class="search-icon">${icon('search', 14)}</span>
          <input class="input" id="rsearch" placeholder="Buscar salas..." value="${escapeHtml(filter.search)}" />
        </div>
      </div>

      ${rooms.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('room', 24)}</div>
          <h3>Nenhuma sala cadastrada</h3>
          <p>Comece cadastrando as salas da sua empresa.</p>
          <button class="btn btn-accent" id="empty-new-room">${icon('plus', 14)} Criar primeira sala</button>
        </div>
      ` : view === 'grid' ? `
        <div class="entity-grid">
          ${rooms.map(r => `
            <div class="entity-card" data-room-id="${r.id}">
              <div class="entity-card-header">
                <div class="entity-color-dot" style="background:${r.color}"></div>
                <div class="entity-name">${escapeHtml(r.name)}</div>
                ${r.active ? '<span class="badge badge-ok badge-dot">Ativa</span>' : '<span class="badge badge-neutral badge-dot">Inativa</span>'}
              </div>
              <div class="entity-meta">
                <div class="entity-meta-row"><span class="label">Capacidade</span><span>${r.capacity} lugares</span></div>
                ${r.description ? `<div class="entity-meta-row"><span class="label">Descrição</span><span style="text-align:right;max-width:60%">${escapeHtml(r.description)}</span></div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th></th><th>Nome</th><th>Capacidade</th><th>Descrição</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${rooms.map(r => `
                <tr data-room-id="${r.id}" style="cursor:pointer">
                  <td><div class="entity-color-dot" style="background:${r.color}"></div></td>
                  <td><strong>${escapeHtml(r.name)}</strong></td>
                  <td>${r.capacity} lugares</td>
                  <td class="text-muted">${escapeHtml(r.description || '—')}</td>
                  <td>${r.active ? '<span class="badge badge-ok badge-dot">Ativa</span>' : '<span class="badge badge-neutral badge-dot">Inativa</span>'}</td>
                  <td><button class="table-action">${icon('edit', 14)}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
    `;
  }

  function bindRoomsEvents() {
    $$('[data-rview]').forEach(b => b.addEventListener('click', () => {
      appView.viewModes.rooms = b.dataset.rview;
      rerender();
    }));
    $$('[data-rstatus]').forEach(b => b.addEventListener('click', () => {
      appView.filters.rooms.status = b.dataset.rstatus;
      rerender();
    }));
    const s = $('#rsearch');
    if (s) s.addEventListener('input', (e) => {
      appView.filters.rooms.search = e.target.value;
      // soft rerender without losing focus
      clearTimeout(window.__rSearchT);
      window.__rSearchT = setTimeout(() => rerender(), 200);
    });
    $('#new-room')?.addEventListener('click', () => openRoomModal());
    $('#empty-new-room')?.addEventListener('click', () => openRoomModal());
    $$('[data-room-id]').forEach(el => {
      el.addEventListener('click', () => openRoomModal(el.dataset.roomId));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const room = findById('rooms', el.dataset.roomId);
        if (!room) return;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Editar sala', icon: 'edit', onClick: () => openRoomModal(room.id) },
          { label: 'Nova aula nesta sala', icon: 'plus', onClick: () => openLessonCreateModal({ roomId: room.id }) },
          { divider: true },
          { label: room.active ? 'Desativar' : 'Ativar', icon: room.active ? 'close' : 'check', onClick: () => { room.active = !room.active; saveState(); rerender(); } },
          { divider: true },
          { label: 'Excluir sala', icon: 'trash', danger: true, onClick: () => {
            const hasLessons = state.lessons.some(l => l.roomId === room.id);
            if (hasLessons) { showError('Não é possível excluir', 'Esta sala possui aulas vinculadas. Desative-a em vez de excluir.'); return; }
            showConfirm('Excluir sala?', 'Esta ação não pode ser desfeita.', () => {
              state.rooms = state.rooms.filter(r => r.id !== room.id);
              saveState(); rerender();
              toast('ok', 'Sala excluída');
            }, 'Excluir', 'danger');
          }}
        ]);
      });
    });
  }

  function openRoomModal(roomId) {
    const room = roomId ? findById('rooms', roomId) : null;
    const isNew = !room;

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Nova sala' : 'Editar sala'}</h3>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Nome da sala</label>
          <input class="input" id="r-name" value="${escapeHtml(room?.name || '')}" placeholder="Ex: Sala Azul" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Capacidade</label>
            <input type="number" class="input" id="r-capacity" value="${room?.capacity || 4}" min="1" />
          </div>
          <div class="field">
            <label class="field-label">Status</label>
            <div class="switch-row" style="padding:8px 0">
              <div class="switch-info"><div class="title">${room?.active !== false ? 'Ativa' : 'Inativa'}</div></div>
              <label class="switch">
                <input type="checkbox" id="r-active" ${room?.active !== false ? 'checked' : ''} />
                <span class="switch-slider"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Descrição</label>
          <textarea class="textarea" id="r-desc" placeholder="Detalhes sobre a sala...">${escapeHtml(room?.description || '')}</textarea>
        </div>
        <div class="field">
          <label class="field-label">Cor de identificação</label>
          <div id="r-colors"></div>
        </div>
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="r-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="r-save">Salvar</button>
      </div>
    `, {
      onMount: (node, close) => {
        let selectedColor = room?.color || DEFAULT_COLORS[0];
        mountColorPicker(node.querySelector('#r-colors'), selectedColor, (c) => { selectedColor = c; });
        node.querySelector('#r-save').addEventListener('click', () => {
          const name = node.querySelector('#r-name').value.trim();
          if (!name) { showError('Nome obrigatório', 'Informe o nome da sala.'); return; }
          const data = {
            id: room?.id || uid('room'),
            name,
            capacity: parseInt(node.querySelector('#r-capacity').value, 10) || 1,
            description: node.querySelector('#r-desc').value.trim(),
            color: selectedColor,
            active: node.querySelector('#r-active').checked
          };
          if (isNew) state.rooms.push(data);
          else Object.assign(room, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Sala criada' : 'Sala atualizada', name);
        });
        if (!isNew) {
          node.querySelector('#r-delete').addEventListener('click', () => {
            const hasLessons = state.lessons.some(l => l.roomId === room.id);
            if (hasLessons) {
              showError('Não é possível excluir', 'Esta sala possui aulas vinculadas. Desative-a em vez de excluir, ou remova os agendamentos antes.');
              return;
            }
            showConfirm('Excluir sala?', 'Esta ação não pode ser desfeita.', () => {
              state.rooms = state.rooms.filter(r => r.id !== room.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Sala excluída');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  // =========================================================
  // TEACHERS VIEW
  // =========================================================

  function renderTeachers() {
    const filter = appView.filters.teachers;
    const view = appView.viewModes.teachers;
    const teachers = state.teachers.filter(t => {
      if (filter.status === 'active' && !t.active) return false;
      if (filter.status === 'inactive' && t.active) return false;
      if (filter.search && !t.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      return true;
    });

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Professores</h2>
          <div class="section-sub">${teachers.length} professor(es) · ${state.teachers.filter(t => t.active).length} ativo(s)</div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <div class="view-toggle">
            <button class="${view === 'list' ? 'active' : ''}" data-tview="list">${icon('list', 14)} Lista</button>
            <button class="${view === 'grid' ? 'active' : ''}" data-tview="grid">${icon('grid', 14)} Blocos</button>
          </div>
          <button class="btn btn-accent" id="new-teacher">${icon('plus', 14)} Novo professor</button>
        </div>
      </div>

      <div class="flex gap-sm mb-md flex-wrap items-center">
        <div class="chip-filters">
          <button class="chip ${filter.status === 'all' ? 'active' : ''}" data-tstatus="all">Todos <span class="count">${state.teachers.length}</span></button>
          <button class="chip ${filter.status === 'active' ? 'active' : ''}" data-tstatus="active">Ativos <span class="count">${state.teachers.filter(t => t.active).length}</span></button>
          <button class="chip ${filter.status === 'inactive' ? 'active' : ''}" data-tstatus="inactive">Inativos <span class="count">${state.teachers.filter(t => !t.active).length}</span></button>
        </div>
        <div style="flex:1"></div>
        <div class="search-global" style="max-width:280px">
          <span class="search-icon">${icon('search', 14)}</span>
          <input class="input" id="tsearch" placeholder="Buscar professores..." value="${escapeHtml(filter.search)}" />
        </div>
      </div>

      ${teachers.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('users', 24)}</div>
          <h3>Nenhum professor cadastrado</h3>
          <p>Comece cadastrando seus professores.</p>
          <button class="btn btn-accent" id="empty-new-teacher">${icon('plus', 14)} Criar primeiro professor</button>
        </div>
      ` : view === 'grid' ? `
        <div class="entity-grid">
          ${teachers.map(t => {
            const monthlyHours = calcTeacherMonthlyHours(t.id);
            return `
            <div class="entity-card" data-teacher-id="${t.id}">
              <div class="entity-card-header">
                <div class="avatar" style="background:${hexToSoftBg(t.color)};color:${darkenHex(t.color)}">${escapeHtml(initials(t.name))}</div>
                <div style="flex:1;min-width:0">
                  <div class="entity-name">${escapeHtml(t.name)}</div>
                  <div class="text-sm text-muted">${escapeHtml(t.specialty || '')}</div>
                </div>
                ${t.active ? '<span class="badge badge-ok badge-dot">Ativo</span>' : '<span class="badge badge-neutral badge-dot">Inativo</span>'}
              </div>
              <div class="entity-meta">
                <div class="entity-meta-row"><span class="label">Contato</span><span>${escapeHtml(t.phone || '—')}</span></div>
                <div class="entity-meta-row"><span class="label">Valor/hora</span><span>${formatCurrency(t.hourlyRate || 0)}</span></div>
                <div class="entity-meta-row"><span class="label">Horas este mês</span><span>${monthlyHours.toFixed(1)}h</span></div>
              </div>
            </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th></th><th>Nome</th><th>Especialidade</th><th>Contato</th><th>Valor/hora</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${teachers.map(t => `
                <tr data-teacher-id="${t.id}" style="cursor:pointer">
                  <td><div class="avatar" style="width:30px;height:30px;font-size:.72rem;background:${hexToSoftBg(t.color)};color:${darkenHex(t.color)}">${escapeHtml(initials(t.name))}</div></td>
                  <td><strong>${escapeHtml(t.name)}</strong></td>
                  <td class="text-muted">${escapeHtml(t.specialty || '—')}</td>
                  <td class="text-muted">${escapeHtml(t.phone || '—')}</td>
                  <td>${formatCurrency(t.hourlyRate || 0)}</td>
                  <td>${t.active ? '<span class="badge badge-ok badge-dot">Ativo</span>' : '<span class="badge badge-neutral badge-dot">Inativo</span>'}</td>
                  <td><button class="table-action">${icon('edit', 14)}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
    `;
  }

  function calcTeacherMonthlyHours(teacherId) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return state.lessons
      .filter(l => l.teacherIds.includes(teacherId) && l.status === 'done' && l.date.startsWith(ym))
      .reduce((sum, l) => sum + (timeToMinutes(l.end) - timeToMinutes(l.start)) / 60, 0);
  }

  function bindTeachersEvents() {
    $$('[data-tview]').forEach(b => b.addEventListener('click', () => {
      appView.viewModes.teachers = b.dataset.tview;
      rerender();
    }));
    $$('[data-tstatus]').forEach(b => b.addEventListener('click', () => {
      appView.filters.teachers.status = b.dataset.tstatus;
      rerender();
    }));
    const s = $('#tsearch');
    if (s) s.addEventListener('input', (e) => {
      appView.filters.teachers.search = e.target.value;
      clearTimeout(window.__tSearchT);
      window.__tSearchT = setTimeout(() => rerender(), 200);
    });
    $('#new-teacher')?.addEventListener('click', () => openTeacherModal());
    $('#empty-new-teacher')?.addEventListener('click', () => openTeacherModal());
    $$('[data-teacher-id]').forEach(el => {
      el.addEventListener('click', () => openTeacherModal(el.dataset.teacherId));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const teacher = findById('teachers', el.dataset.teacherId);
        if (!teacher) return;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Editar professor', icon: 'edit', onClick: () => openTeacherModal(teacher.id) },
          { label: 'Nova aula com este professor', icon: 'plus', onClick: () => openLessonCreateModal({ teacherIds: [teacher.id] }) },
          { divider: true },
          { label: teacher.active ? 'Desativar' : 'Ativar', icon: teacher.active ? 'close' : 'check', onClick: () => { teacher.active = !teacher.active; saveState(); rerender(); } },
          { label: 'Copiar telefone', icon: 'copy', disabled: !teacher.phone, onClick: () => { navigator.clipboard.writeText(teacher.phone).then(() => toast('ok', 'Copiado')); } },
          { divider: true },
          { label: 'Excluir professor', icon: 'trash', danger: true, onClick: () => {
            const hasLessons = state.lessons.some(l => l.teacherIds.includes(teacher.id));
            if (hasLessons) { showError('Não é possível excluir', 'Este professor possui aulas vinculadas. Desative-o em vez de excluir.'); return; }
            showConfirm('Excluir professor?', 'Esta ação não pode ser desfeita.', () => {
              state.teachers = state.teachers.filter(t => t.id !== teacher.id);
              saveState(); rerender();
              toast('ok', 'Professor excluído');
            }, 'Excluir', 'danger');
          }}
        ]);
      });
    });
  }

  function openTeacherModal(teacherId) {
    const teacher = teacherId ? findById('teachers', teacherId) : null;
    const isNew = !teacher;
    const paymentMethods = ['PIX', 'Transferência Bancária', 'Dinheiro', 'Cartão', 'Outros'];
    let currentMethod = teacher?.paymentMethod || 'PIX';

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Novo professor' : 'Editar professor'}</h3>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Nome completo</label>
            <input class="input" id="t-name" value="${escapeHtml(teacher?.name || '')}" />
          </div>
          <div class="field">
            <label class="field-label">Especialidade</label>
            <input class="input" id="t-specialty" value="${escapeHtml(teacher?.specialty || '')}" placeholder="Ex: Matemática" />
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Telefone</label>
            <input class="input" id="t-phone" value="${escapeHtml(teacher?.phone || '')}" placeholder="(48) 99999-0000" />
          </div>
          <div class="field">
            <label class="field-label">E-mail</label>
            <input type="email" class="input" id="t-email" value="${escapeHtml(teacher?.email || '')}" />
          </div>
        </div>

        <div class="field">
          <label class="field-label">Endereço</label>
          <input class="input" id="t-address" value="${escapeHtml(teacher?.address || '')}" />
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Valor por hora</label>
            <input type="number" class="input" id="t-rate" value="${teacher?.hourlyRate || 0}" step="0.01" />
          </div>
          <div class="field">
            <label class="field-label">Forma de pagamento</label>
            <select class="select" id="t-method">
              ${paymentMethods.map(m => `<option value="${m}" ${currentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="field" id="t-pix-field" style="${currentMethod === 'PIX' ? '' : 'display:none'}">
          <label class="field-label">Chave PIX</label>
          <input class="input" id="t-pix" value="${escapeHtml(teacher?.pixKey || '')}" placeholder="E-mail, CPF, telefone ou aleatória" />
        </div>

        <div class="field" id="t-notes-field" style="${currentMethod !== 'PIX' ? '' : 'display:none'}">
          <label class="field-label">Observações de pagamento</label>
          <textarea class="textarea" id="t-notes" placeholder="Ex: conta corrente do Banco X, agência 0001, conta 12345...">${escapeHtml(teacher?.paymentNotes || '')}</textarea>
        </div>

        <div class="field">
          <label class="field-label">Cor de identificação</label>
          <div id="t-colors"></div>
        </div>

        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Professor ativo</div>
            <div class="desc">Apenas professores ativos aparecem nos novos agendamentos.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="t-active" ${teacher?.active !== false ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="t-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="t-save">Salvar</button>
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {
        let selectedColor = teacher?.color || DEFAULT_COLORS[1];
        mountColorPicker(node.querySelector('#t-colors'), selectedColor, (c) => { selectedColor = c; });

        node.querySelector('#t-method').addEventListener('change', (e) => {
          currentMethod = e.target.value;
          node.querySelector('#t-pix-field').style.display = currentMethod === 'PIX' ? '' : 'none';
          node.querySelector('#t-notes-field').style.display = currentMethod !== 'PIX' ? '' : 'none';
        });

        node.querySelector('#t-save').addEventListener('click', () => {
          const name = node.querySelector('#t-name').value.trim();
          if (!name) { showError('Nome obrigatório', 'Informe o nome do professor.'); return; }
          const data = {
            id: teacher?.id || uid('teacher'),
            name,
            specialty: node.querySelector('#t-specialty').value.trim(),
            phone: node.querySelector('#t-phone').value.trim(),
            email: node.querySelector('#t-email').value.trim(),
            address: node.querySelector('#t-address').value.trim(),
            hourlyRate: parseFloat(node.querySelector('#t-rate').value) || 0,
            paymentMethod: currentMethod,
            pixKey: currentMethod === 'PIX' ? node.querySelector('#t-pix').value.trim() : '',
            paymentNotes: currentMethod !== 'PIX' ? node.querySelector('#t-notes').value.trim() : '',
            color: selectedColor,
            active: node.querySelector('#t-active').checked
          };
          if (isNew) state.teachers.push(data);
          else Object.assign(teacher, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Professor cadastrado' : 'Professor atualizado', name);
        });

        if (!isNew) {
          node.querySelector('#t-delete').addEventListener('click', () => {
            const hasLessons = state.lessons.some(l => l.teacherIds.includes(teacher.id));
            if (hasLessons) {
              showError('Não é possível excluir', 'Este professor possui aulas vinculadas. Desative-o em vez de excluir.');
              return;
            }
            showConfirm('Excluir professor?', 'Esta ação não pode ser desfeita.', () => {
              state.teachers = state.teachers.filter(t => t.id !== teacher.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Professor excluído');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  // =========================================================
  // STUDENTS VIEW
  // =========================================================

  function renderStudents() {
    const filter = appView.filters.students;
    const view = appView.viewModes.students;
    let students = state.students.filter(s => {
      if (filter.status === 'active' && !s.active) return false;
      if (filter.status === 'inactive' && s.active) return false;
      if (filter.status === 'pending') {
        const st = getStudentLessonStatus(s);
        if (st.remaining > 0) return false;
      }
      if (filter.favorite && !s.favorite) return false;
      if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      return true;
    });
    // Favorites first
    students.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

    const pendingCount = state.students.filter(s => {
      const st = getStudentLessonStatus(s);
      return s.active && st.remaining <= 0;
    }).length;

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Alunos</h2>
          <div class="section-sub">${students.length} aluno(s) · ${state.students.filter(s => s.active).length} ativo(s)${pendingCount > 0 ? ` · ${pendingCount} pendente(s)` : ''}</div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <div class="view-toggle">
            <button class="${view === 'list' ? 'active' : ''}" data-sview="list">${icon('list', 14)} Lista</button>
            <button class="${view === 'grid' ? 'active' : ''}" data-sview="grid">${icon('grid', 14)} Blocos</button>
          </div>
          <button class="btn btn-ghost" id="import-students">${icon('upload', 14)} Importar</button>
          <button class="btn btn-ghost" id="register-lessons">${icon('plus', 14)} Cadastrar aulas</button>
          <button class="btn btn-accent" id="new-student">${icon('plus', 14)} Novo aluno</button>
        </div>
      </div>

      <div class="flex gap-sm mb-md flex-wrap items-center">
        <div class="chip-filters">
          <button class="chip ${filter.status === 'all' ? 'active' : ''}" data-sstatus="all">Todos <span class="count">${state.students.length}</span></button>
          <button class="chip ${filter.status === 'active' ? 'active' : ''}" data-sstatus="active">Ativos <span class="count">${state.students.filter(s => s.active).length}</span></button>
          <button class="chip ${filter.status === 'pending' ? 'active' : ''}" data-sstatus="pending">Pendentes <span class="count">${pendingCount}</span></button>
          <button class="chip ${filter.status === 'inactive' ? 'active' : ''}" data-sstatus="inactive">Inativos <span class="count">${state.students.filter(s => !s.active).length}</span></button>
          <button class="chip ${filter.favorite ? 'active' : ''}" id="fav-toggle">${icon('star', 12)} Favoritos <span class="count">${state.students.filter(s => s.favorite).length}</span></button>
        </div>
        <div style="flex:1"></div>
        <div class="search-global" style="max-width:280px">
          <span class="search-icon">${icon('search', 14)}</span>
          <input class="input" id="ssearch" placeholder="Buscar alunos..." value="${escapeHtml(filter.search)}" />
        </div>
      </div>

      ${students.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('user', 24)}</div>
          <h3>Nenhum aluno encontrado</h3>
          <p>Comece cadastrando seus alunos ou ajuste os filtros.</p>
          <button class="btn btn-accent" id="empty-new-student">${icon('plus', 14)} Criar primeiro aluno</button>
        </div>
      ` : view === 'grid' ? `
        <div class="entity-grid">
          ${students.map(s => renderStudentCard(s)).join('')}
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th></th><th>Nome</th><th>Contato</th><th>Aulas</th><th>Agendadas</th><th>Preço</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${students.map(s => {
                const st = getStudentLessonStatus(s);
                const pricing = getStudentPricing(s);
                const hasCustom = s.customPricing && (s.packagePrice != null || s.singleLessonPrice != null);
                return `
                <tr data-student-id="${s.id}" style="cursor:pointer">
                  <td style="width:40px">
                    <button class="star-btn ${s.favorite ? 'active' : ''}" data-fav-student="${s.id}" title="Favoritar">${icon('star', 14)}</button>
                  </td>
                  <td><strong>${escapeHtml(s.name)}</strong></td>
                  <td class="text-muted">${escapeHtml(s.phone || '—')}</td>
                  <td>
                    <span class="lesson-count lc-${st.color}">
                      ${st.used}/${st.total}
                      <span class="lesson-count-bar"><span class="lesson-count-bar-fill" style="width:${Math.min(100, st.pct * 100)}%"></span></span>
                    </span>
                  </td>
                  <td><span class="badge ${st.scheduled > 0 ? 'badge-info' : 'badge-neutral'} badge-dot">${st.scheduled}</span></td>
                  <td>
                    ${hasCustom
                      ? `<span class="custom-pricing-badge" title="Avulsa: ${formatCurrency(pricing.singleLessonPrice)} · Pacote: ${formatCurrency(pricing.packagePrice)}" style="white-space:nowrap">${icon('star', 10)} personalizado</span>`
                      : `<span class="text-xs text-muted">padrão</span>`
                    }
                  </td>
                  <td>${s.active ? (st.available === 0 ? '<span class="badge badge-danger badge-dot">Sem saldo</span>' : '<span class="badge badge-ok badge-dot">Ativo</span>') : '<span class="badge badge-neutral badge-dot">Inativo</span>'}</td>
                  <td><button class="table-action">${icon('edit', 14)}</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
    `;
  }

  function renderStudentCard(s) {
    const st = getStudentLessonStatus(s);
    const color = s.color || DEFAULT_COLORS[2];
    const pricing = getStudentPricing(s);
    const hasCustomPricing = s.customPricing && (s.packagePrice != null || s.singleLessonPrice != null);
    return `
    <div class="entity-card" data-student-id="${s.id}">
      <div class="entity-card-header">
        <div class="avatar" style="background:${hexToSoftBg(color)};color:${darkenHex(color)}">${escapeHtml(initials(s.name))}</div>
        <div style="flex:1;min-width:0">
          <div class="entity-name">${escapeHtml(s.name)}</div>
          <div class="text-sm text-muted">${escapeHtml(s.phone || '—')}</div>
        </div>
        <button class="star-btn ${s.favorite ? 'active' : ''}" data-fav-student="${s.id}">${icon('star', 16)}</button>
      </div>
      <div class="flex items-center gap-sm mb-sm" style="justify-content:space-between">
        <span class="lesson-count lc-${st.color}">
          ${st.used}/${st.total} aulas
          <span class="lesson-count-bar"><span class="lesson-count-bar-fill" style="width:${Math.min(100, st.pct * 100)}%"></span></span>
        </span>
        ${!s.active ? '<span class="badge badge-neutral badge-dot">Inativo</span>' :
          st.available === 0 ? '<span class="badge badge-danger badge-dot">Sem saldo</span>' :
          st.available <= 1 ? '<span class="badge badge-warn badge-dot">Crítico</span>' :
          '<span class="badge badge-ok badge-dot">Ativo</span>'}
      </div>
      <div class="text-xs text-muted flex gap-md" style="margin-bottom:4px">
        <span>${icon('cal', 11)} ${st.scheduled} agendada(s)</span>
        <span>${icon('check', 11)} ${st.available} disponível(is)</span>
      </div>
      ${hasCustomPricing ? `
        <div class="custom-pricing-badge" title="Avulsa: ${formatCurrency(pricing.singleLessonPrice)} · Pacote: ${formatCurrency(pricing.packagePrice)}">
          ${icon('star', 10)} Valor personalizado · avulsa ${formatCurrency(pricing.singleLessonPrice)} · pacote ${formatCurrency(pricing.packagePrice)}
        </div>
      ` : ''}
      ${s.guardianName ? `<div class="text-sm text-muted mt-sm"><strong>Responsável:</strong> ${escapeHtml(s.guardianName)}</div>` : ''}
    </div>
    `;
  }

  function bindStudentsEvents() {
    $$('[data-sview]').forEach(b => b.addEventListener('click', () => {
      appView.viewModes.students = b.dataset.sview;
      rerender();
    }));
    $$('[data-sstatus]').forEach(b => b.addEventListener('click', () => {
      appView.filters.students.status = b.dataset.sstatus;
      rerender();
    }));
    $('#fav-toggle')?.addEventListener('click', () => {
      appView.filters.students.favorite = !appView.filters.students.favorite;
      rerender();
    });
    const s = $('#ssearch');
    if (s) s.addEventListener('input', (e) => {
      appView.filters.students.search = e.target.value;
      clearTimeout(window.__sSearchT);
      window.__sSearchT = setTimeout(() => rerender(), 200);
    });
    $('#new-student')?.addEventListener('click', () => openStudentModal());
    $('#empty-new-student')?.addEventListener('click', () => openStudentModal());
    $('#import-students')?.addEventListener('click', () => openImportModal());
    $('#register-lessons')?.addEventListener('click', () => openRenewContractModal());
    $$('[data-student-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.star-btn')) return;
        openStudentModal(el.dataset.studentId);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const student = findById('students', el.dataset.studentId);
        if (!student) return;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Abrir ficha', icon: 'info', onClick: () => openStudentModal(student.id) },
          { label: 'Agendar aula', icon: 'plus', onClick: () => openLessonCreateModal({ studentIds: [student.id] }) },
          { label: 'Cadastrar / renovar aulas', icon: 'repeat', onClick: () => openRenewContractModal(student.id) },
          { divider: true },
          { label: student.favorite ? 'Remover dos favoritos' : 'Marcar como favorito', icon: 'star', onClick: () => { student.favorite = !student.favorite; saveState(); rerender(); } },
          { label: student.active ? 'Desativar' : 'Ativar', icon: student.active ? 'close' : 'check', onClick: () => { student.active = !student.active; saveState(); rerender(); toast('ok', student.active ? 'Aluno ativado' : 'Aluno desativado'); } },
          { divider: true },
          { label: 'Enviar WhatsApp', icon: 'wa', disabled: !student.phone, onClick: () => {
            const phone = student.phone.replace(/\D/g, '');
            const withCountry = phone.startsWith('55') ? phone : '55' + phone;
            window.open(`https://wa.me/${withCountry}`, '_blank');
          }},
          { label: 'Copiar telefone', icon: 'copy', disabled: !student.phone, onClick: () => {
            navigator.clipboard.writeText(student.phone).then(() => toast('ok', 'Telefone copiado'));
          }},
          { divider: true },
          { label: 'Excluir aluno', icon: 'trash', danger: true, onClick: () => {
            const hasLessons = state.lessons.some(l => l.studentIds.includes(student.id));
            if (hasLessons) { showError('Não é possível excluir', 'Este aluno possui aulas vinculadas. Desative-o em vez de excluir.'); return; }
            showConfirm('Excluir aluno?', 'Esta ação não pode ser desfeita.', () => {
              state.students = state.students.filter(s => s.id !== student.id);
              saveState(); rerender();
              toast('ok', 'Aluno excluído');
            }, 'Excluir', 'danger');
          }}
        ]);
      });
    });
    $$('[data-fav-student]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.dataset.favStudent;
        const student = findById('students', id);
        if (student) {
          student.favorite = !student.favorite;
          saveState();
          rerender();
        }
      });
    });
  }

  function renderStudentHistory(student) {
    // All lessons for this student, most recent first
    const lessons = state.lessons
      .filter(l => l.studentIds.includes(student.id))
      .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));

    if (lessons.length === 0) {
      return `
        <div class="empty-state" style="padding:2rem">
          <div class="empty-state-icon">${icon('clock', 24)}</div>
          <h3>Sem histórico ainda</h3>
          <p>As aulas passadas aparecerão aqui conforme forem registradas.</p>
        </div>
      `;
    }

    return `
      <div class="today-list">
        ${lessons.map(l => {
          const room = findById('rooms', l.roomId);
          const teachers = l.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
          const color = room?.color || '#c6833a';
          let badge = '';
          if (l.status === 'done') badge = '<span class="badge badge-ok badge-dot">Concluída</span>';
          else if (l.status === 'canceled') badge = `<span class="badge badge-danger badge-dot">${l.needsReplacement ? 'Remarcar' : 'Cancelada'}</span>`;
          else badge = '<span class="badge badge-info badge-dot">Agendada</span>';
          return `
            <div class="today-item" style="border-left-color:${color}">
              <div class="time-block" style="width:110px">
                <strong>${formatDate(l.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</strong><br/>
                <span style="opacity:.7">${l.start}</span>
              </div>
              <div class="info">
                <div class="title">${escapeHtml(teachers || 'Sem professor')} · ${escapeHtml(room?.name || '')}</div>
                <div class="sub">${escapeHtml(l.notes || l.cancelReason || '—')}</div>
              </div>
              ${badge}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderStudentScheduled(student) {
    const scheduled = state.lessons
      .filter(l => l.studentIds.includes(student.id) && l.status === 'scheduled')
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

    if (scheduled.length === 0) {
      return `
        <div class="empty-state" style="padding:2rem">
          <div class="empty-state-icon">${icon('cal', 24)}</div>
          <h3>Nenhuma aula agendada</h3>
          <p>${escapeHtml(student.name)} não tem aulas futuras no calendário.</p>
        </div>
      `;
    }

    return `
      <div class="text-sm text-muted mb-md">${scheduled.length} aula(s) agendada(s) para ${escapeHtml(student.name)}</div>
      <div class="today-list">
        ${scheduled.map(l => {
          const room = findById('rooms', l.roomId);
          const teachers = l.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
          const color = room?.color || '#c6833a';
          const d = parseDate(l.date);
          return `
            <div class="today-item" style="border-left-color:${color}">
              <div class="time-block" style="width:110px">
                <strong>${formatDate(l.date, { day: '2-digit', month: '2-digit' })}</strong>
                <span style="font-size:.72rem;color:var(--ink-subtle);display:block">${dowLabel(d.getDay(), false)}</span>
              </div>
              <div class="info">
                <div class="title">${l.start} — ${l.end}</div>
                <div class="sub">${escapeHtml(teachers || 'Sem professor')} · ${escapeHtml(room?.name || '')}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderStudentFinancial(student) {
    const status = getStudentLessonStatus(student);
    const pricing = getStudentPricing(student);
    const doneLessons = state.lessons.filter(l => l.studentIds.includes(student.id) && l.status === 'done');
    const totalPaidLessons = status.used; // manual count as "realized"
    const packageValue = pricing.packagePrice;
    const singleValue = pricing.singleLessonPrice;

    // Infer financial status
    let finStatus, finBadge, finDesc;
    if (status.available === 0 && status.used >= status.total) {
      finStatus = 'needs-renewal';
      finBadge = '<span class="badge badge-danger badge-dot">Precisa renovar</span>';
      finDesc = 'Pacote esgotado. É necessário renovar para continuar.';
    } else if (status.available <= 1) {
      finStatus = 'critical';
      finBadge = '<span class="badge badge-warn badge-dot">Atenção</span>';
      finDesc = `Apenas ${status.available} aula(s) disponível(is) para agendar.`;
    } else {
      finStatus = 'ok';
      finBadge = '<span class="badge badge-ok badge-dot">Em dia</span>';
      finDesc = `${status.available} aula(s) disponível(is) · pacote contratado.`;
    }

    return `
      <div class="card" style="padding:16px;margin-bottom:12px">
        <div class="flex items-center gap-sm mb-md">
          <div style="flex:1">
            <div style="font-size:.75rem;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Situação</div>
            <div style="font-family:var(--font-display);font-style:italic;font-size:1.3rem">${finStatus === 'ok' ? 'Em dia' : finStatus === 'critical' ? 'Atenção' : 'Precisa renovar'}</div>
          </div>
          ${finBadge}
        </div>
        <p class="text-sm text-muted" style="margin:0">${escapeHtml(finDesc)}</p>
      </div>

      <div class="metrics-grid" style="margin-bottom:12px">
        <div class="metric">
          <div class="metric-label">Pacote</div>
          <div class="metric-value" style="font-size:1.5rem">${formatCurrency(packageValue)}</div>
          <div class="metric-delta">${status.total} aulas</div>
        </div>
        <div class="metric m-teal">
          <div class="metric-label">Aula avulsa</div>
          <div class="metric-value" style="font-size:1.5rem">${formatCurrency(singleValue)}</div>
          <div class="metric-delta">valor unitário</div>
        </div>
        <div class="metric m-info">
          <div class="metric-label">Aulas realizadas</div>
          <div class="metric-value" style="font-size:1.5rem">${status.used}</div>
          <div class="metric-delta">de ${status.total}</div>
        </div>
      </div>

      ${student.customPricing ? `
        <div class="card" style="padding:12px;background:var(--info-soft);border-color:var(--info-soft);margin-bottom:12px">
          <div class="flex items-center gap-sm">
            ${icon('info', 14)}
            <div class="text-sm" style="color:var(--info-ink)">Este aluno tem valores personalizados (diferentes do padrão do sistema).</div>
          </div>
        </div>
      ` : ''}

      <div class="card" style="padding:12px">
        <div style="font-weight:500;margin-bottom:8px">Responsável financeiro</div>
        ${student.guardianIsFinancial && student.guardianName ? `
          <div class="text-sm">${escapeHtml(student.guardianName)}</div>
          <div class="text-sm text-muted">${escapeHtml(student.guardianPhone || '—')}</div>
        ` : `
          <div class="text-sm">${escapeHtml(student.name)} (próprio aluno)</div>
          <div class="text-sm text-muted">${escapeHtml(student.phone || '—')}</div>
        `}
      </div>
    `;
  }

  function openStudentModal(studentId) {
    const student = studentId ? findById('students', studentId) : null;
    const isNew = !student;
    const tabs = isNew ? '' : `
      <div class="tabs" style="margin:-4px 0 16px">
        <button class="tab active" data-smtab="data">Dados</button>
        <button class="tab" data-smtab="history">Histórico</button>
        <button class="tab" data-smtab="scheduled">Agendadas</button>
        <button class="tab" data-smtab="financial">Financeiro</button>
      </div>
    `;

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Novo aluno' : escapeHtml(student.name)}</h3>
          ${!isNew ? `<p class="modal-sub">${getStudentLessonStatus(student).used}/${getStudentLessonStatus(student).total} realizadas · ${getStudentLessonStatus(student).scheduled} agendadas · ${getStudentLessonStatus(student).available} disponíveis</p>` : ''}
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        ${tabs}
        <div id="smtab-data">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Nome completo</label>
            <input class="input" id="s-name" value="${escapeHtml(student?.name || '')}" />
          </div>
          <div class="field">
            <label class="field-label">Telefone</label>
            <input class="input" id="s-phone" value="${escapeHtml(student?.phone || '')}" placeholder="(48) 99999-0000" />
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">E-mail</label>
            <input type="email" class="input" id="s-email" value="${escapeHtml(student?.email || '')}" />
          </div>
          <div class="field">
            <label class="field-label">Endereço</label>
            <input class="input" id="s-address" value="${escapeHtml(student?.address || '')}" />
          </div>
        </div>

        <h4 style="font-size:1.1rem;margin-bottom:8px;margin-top:16px">Responsável</h4>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Nome do responsável</label>
            <input class="input" id="s-guardian-name" value="${escapeHtml(student?.guardianName || '')}" />
          </div>
          <div class="field">
            <label class="field-label">Contato do responsável</label>
            <input class="input" id="s-guardian-phone" value="${escapeHtml(student?.guardianPhone || '')}" />
          </div>
        </div>

        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Responsável financeiro?</div>
            <div class="desc">Marque se o responsável é quem cuida dos pagamentos.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="s-guardian-financial" ${student?.guardianIsFinancial ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <h4 style="font-size:1.1rem;margin-bottom:8px;margin-top:16px">Aulas e valores</h4>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Aulas contratadas</label>
            <input type="number" class="input" id="s-pkg-size" value="${student?.packageSize ?? 0}" min="0" />
          </div>
          <div class="field">
            <label class="field-label">Aulas já realizadas</label>
            <input type="number" class="input" id="s-completed" value="${student?.lessonsCompleted ?? 0}" min="0" />
          </div>
        </div>

        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Valores personalizados</div>
            <div class="desc">Se ativado, sobrescreve os valores padrão das configurações para este aluno.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="s-custom-pricing" ${student?.customPricing ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="grid-2" id="s-custom-prices" style="${student?.customPricing ? '' : 'display:none'}">
          <div class="field">
            <label class="field-label">Valor do pacote</label>
            <input type="number" class="input" id="s-pkg-price" value="${student?.packagePrice ?? ''}" step="0.01" placeholder="${state.settings.packagePrice}" />
          </div>
          <div class="field">
            <label class="field-label">Valor da aula avulsa</label>
            <input type="number" class="input" id="s-single-price" value="${student?.singleLessonPrice ?? ''}" step="0.01" placeholder="${state.settings.singleLessonPrice}" />
          </div>
        </div>

        <h4 style="font-size:1.1rem;margin-bottom:8px;margin-top:16px">Outros</h4>

        <div class="field">
          <label class="field-label">Cor de identificação</label>
          <div id="s-colors"></div>
        </div>

        <div class="field">
          <label class="field-label">Grupo/turma (opcional)</label>
          <select class="select" id="s-group">
            <option value="">Sem grupo</option>
            ${state.groups.map(g => `<option value="${g.id}" ${student?.group === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
          </select>
        </div>

        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Aluno ativo</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="s-active" ${student?.active !== false ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="switch-row">
          <div class="switch-info">
            <div class="title">Favoritar</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="s-favorite" ${student?.favorite ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
        </div>
        ${!isNew ? `
        <div id="smtab-history" style="display:none">${renderStudentHistory(student)}</div>
        <div id="smtab-scheduled" style="display:none">${renderStudentScheduled(student)}</div>
        <div id="smtab-financial" style="display:none">${renderStudentFinancial(student)}</div>
        ` : ''}
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="s-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="s-save">Salvar</button>
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {
        // Tab switching
        node.querySelectorAll('[data-smtab]').forEach(b => {
          b.addEventListener('click', () => {
            node.querySelectorAll('[data-smtab]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            const tab = b.dataset.smtab;
            ['data', 'history', 'scheduled', 'financial'].forEach(t => {
              const el = node.querySelector(`#smtab-${t}`);
              if (el) el.style.display = tab === t ? '' : 'none';
            });
          });
        });

        let selectedColor = student?.color || DEFAULT_COLORS[2];
        mountColorPicker(node.querySelector('#s-colors'), selectedColor, (c) => { selectedColor = c; });

        node.querySelector('#s-custom-pricing').addEventListener('change', (e) => {
          node.querySelector('#s-custom-prices').style.display = e.target.checked ? '' : 'none';
        });
        node.querySelector('#s-save').addEventListener('click', () => {
          const name = node.querySelector('#s-name').value.trim();
          if (!name) { showError('Nome obrigatório', 'Informe o nome do aluno.'); return; }
          const customPricing = node.querySelector('#s-custom-pricing').checked;
          const data = {
            id: student?.id || uid('student'),
            name,
            phone: node.querySelector('#s-phone').value.trim(),
            email: node.querySelector('#s-email').value.trim(),
            address: node.querySelector('#s-address').value.trim(),
            guardianName: node.querySelector('#s-guardian-name').value.trim(),
            guardianPhone: node.querySelector('#s-guardian-phone').value.trim(),
            guardianIsFinancial: node.querySelector('#s-guardian-financial').checked,
            active: node.querySelector('#s-active').checked,
            favorite: node.querySelector('#s-favorite').checked,
            customPricing,
            color: selectedColor,
            packageSize: Math.max(0, parseInt(node.querySelector('#s-pkg-size').value, 10) || 0),
            lessonsCompleted: Math.max(0, parseInt(node.querySelector('#s-completed').value, 10) || 0),
            packagePrice: customPricing ? (parseFloat(node.querySelector('#s-pkg-price').value) || null) : null,
            singleLessonPrice: customPricing ? (parseFloat(node.querySelector('#s-single-price').value) || null) : null,
            group: node.querySelector('#s-group').value || null,
            createdAt: student?.createdAt || Date.now()
          };
          if (isNew) state.students.push(data);
          else Object.assign(student, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Aluno cadastrado' : 'Aluno atualizado', name);
        });

        if (!isNew) {
          node.querySelector('#s-delete').addEventListener('click', () => {
            const hasLessons = state.lessons.some(l => l.studentIds.includes(student.id));
            if (hasLessons) {
              showError('Não é possível excluir', 'Este aluno possui aulas vinculadas. Desative-o em vez de excluir.');
              return;
            }
            showConfirm('Excluir aluno?', 'Esta ação não pode ser desfeita.', () => {
              state.students = state.students.filter(s => s.id !== student.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Aluno excluído');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  // =========================================================
  // IMPORT STUDENTS
  // =========================================================

  // =========================================================
  // RENEW CONTRACT MODAL — add lessons to a student's package
  // =========================================================

  function openRenewContractModal(studentId = null, opts = {}) {
    const students = state.students.filter(s => s.active);
    if (students.length === 0) {
      showError('Sem alunos ativos', 'Cadastre alunos antes de registrar uma contratação.');
      return;
    }

    const pkgDefault = state.settings.packageSize || 4;
    let mode = 'package'; // 'single' | 'package' | 'custom'

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Cadastrar aulas</h3>
          <p class="modal-sub">Contratação de aula avulsa, pacote ou quantidade customizada</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="Fechar">${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Aluno</label>
          <select class="select" id="rc-student">
            <option value="">— Selecione um aluno —</option>
            ${students.map(s => {
              const st = getStudentLessonStatus(s);
              return `<option value="${s.id}" ${s.id === studentId ? 'selected' : ''}>${escapeHtml(s.name)} (${st.used}/${st.total} · restam ${st.remaining})</option>`;
            }).join('')}
          </select>
          <div id="rc-student-pricing-hint" style="display:none;margin-top:6px;font-size:.78rem;color:var(--ink-muted)"></div>
        </div>

        <div class="field">
          <label class="field-label">Tipo de contratação</label>
          <div class="zoom-selector" style="width:100%">
            <button type="button" data-rc-mode="single" style="flex:1">Avulsa (1 aula)</button>
            <button type="button" class="active" data-rc-mode="package" style="flex:1">Pacote (${pkgDefault} aulas)</button>
            <button type="button" data-rc-mode="custom" style="flex:1">Personalizado</button>
          </div>
        </div>

        <div class="field" id="rc-custom-wrap" style="display:none">
          <label class="field-label">Quantidade de aulas</label>
          <input type="number" class="input" id="rc-count" value="${pkgDefault}" min="1" max="200" />
        </div>

        <div class="field">
          <div class="flex items-center justify-between mb-xs">
            <label class="field-label" style="margin:0">Valor</label>
            <span id="rc-amount-hint" style="font-size:.72rem;color:var(--ink-subtle)"></span>
          </div>
          <input type="number" class="input" id="rc-amount" step="0.01" placeholder="0,00" value="" />
          <div class="field-hint">Se preenchido, gera uma cobrança no Financeiro.</div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Vencimento da cobrança</label>
            <input type="date" class="input" id="rc-due" value="${todayStr()}" />
          </div>
          <div class="field">
            <label class="field-label">Status inicial</label>
            <select class="select" id="rc-pay-status">
              <option value="pending">Pendente</option>
              <option value="paid">Já pago</option>
            </select>
          </div>
        </div>

        <div id="rc-preview" class="card" style="background:var(--info-soft);border-color:var(--info-soft);padding:12px;margin-top:8px;display:none">
          <div style="color:var(--info-ink);font-size:.85rem;line-height:1.5" id="rc-preview-text"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-accent" id="rc-save">Cadastrar aulas</button>
      </div>
    `, {
      size: 'md',
      onMount: (node, close) => {
        const studentSelect = node.querySelector('#rc-student');
        const customWrap = node.querySelector('#rc-custom-wrap');
        const countInput = node.querySelector('#rc-count');
        const preview = node.querySelector('#rc-preview');
        const previewText = node.querySelector('#rc-preview-text');
        const amountInput = node.querySelector('#rc-amount');
        const amountHint = node.querySelector('#rc-amount-hint');
        const pricingHint = node.querySelector('#rc-student-pricing-hint');

        const getCount = () => {
          if (mode === 'single') return 1;
          if (mode === 'package') return state.settings.packageSize || 4;
          return parseInt(countInput.value, 10) || 1;
        };

        // Returns { single, package, isCustom } for current student
        const getStudentPrices = () => {
          const sid = studentSelect.value;
          const s = sid ? findById('students', sid) : null;
          const isCustom = s?.customPricing && (s?.packagePrice != null || s?.singleLessonPrice != null);
          return {
            single: (isCustom && s.singleLessonPrice != null) ? s.singleLessonPrice : (state.settings.singleLessonPrice || 0),
            package: (isCustom && s.packagePrice != null) ? s.packagePrice : (state.settings.packagePrice || 0),
            isCustom,
            student: s
          };
        };

        // Fill amount field with the right default for the current mode/student
        const autoFillAmount = () => {
          const prices = getStudentPrices();
          let suggested = 0;
          let hintText = '';

          if (mode === 'single') {
            suggested = prices.single;
            hintText = prices.isCustom
              ? `${icon('star', 10)} Valor avulsa personalizado do aluno`
              : 'Valor avulsa padrão do sistema';
          } else if (mode === 'package') {
            suggested = prices.package;
            hintText = prices.isCustom
              ? `${icon('star', 10)} Valor de pacote personalizado do aluno`
              : 'Valor de pacote padrão do sistema';
          } else {
            // custom — suggest package proportional or leave blank
            suggested = 0;
            hintText = 'Informe o valor combinado';
          }

          if (suggested > 0) {
            amountInput.value = suggested.toFixed(2);
          } else {
            amountInput.value = '';
          }
          amountHint.innerHTML = hintText;
        };

        // Show pricing info about the student
        const updateStudentHint = () => {
          const prices = getStudentPrices();
          if (!prices.student) {
            pricingHint.style.display = 'none';
            return;
          }
          if (prices.isCustom) {
            pricingHint.innerHTML = `${icon('star', 11)} <strong>Valores personalizados:</strong> avulsa ${formatCurrency(prices.single)} · pacote ${formatCurrency(prices.package)}`;
            pricingHint.style.display = '';
          } else {
            pricingHint.innerHTML = `Usando valores padrão do sistema: avulsa ${formatCurrency(prices.single)} · pacote ${formatCurrency(prices.package)}`;
            pricingHint.style.display = '';
          }
        };

        const updatePreview = () => {
          const sid = studentSelect.value;
          if (!sid) { preview.style.display = 'none'; return; }
          const s = findById('students', sid);
          if (!s) { preview.style.display = 'none'; return; }
          const st = getStudentLessonStatus(s);
          const count = getCount();
          const newContracted = st.remaining + count;
          previewText.innerHTML = `
            <strong>Como ficará ${escapeHtml(s.name)}:</strong><br/>
            • Antes: ${st.used} realizadas de ${st.total} contratadas · ${st.remaining} restantes<br/>
            • Adicionando ${count} aula(s)<br/>
            • Depois: <strong>${newContracted} aulas contratadas</strong>, <strong>0 realizadas</strong> (reset) · <strong>${newContracted} restantes</strong>
          `;
          preview.style.display = '';
        };

        const onStudentChange = () => {
          updateStudentHint();
          autoFillAmount();
          updatePreview();
        };

        node.querySelectorAll('[data-rc-mode]').forEach(b => {
          b.addEventListener('click', () => {
            node.querySelectorAll('[data-rc-mode]').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            mode = b.dataset.rcMode;
            customWrap.style.display = mode === 'custom' ? '' : 'none';
            autoFillAmount();
            updatePreview();
          });
        });

        studentSelect.addEventListener('change', onStudentChange);
        countInput.addEventListener('input', updatePreview);

        // Init
        onStudentChange();

        node.querySelector('#rc-save').addEventListener('click', () => {
          const sid = studentSelect.value;
          if (!sid) { showError('Selecione um aluno', 'Escolha o aluno que contratou as aulas.'); return; }
          const student = findById('students', sid);
          if (!student) return;
          const count = getCount();
          if (count < 1) { showError('Quantidade inválida', 'A quantidade precisa ser pelo menos 1.'); return; }
          const st = getStudentLessonStatus(student);
          const newContracted = st.remaining + count;

          // Apply: contracted = remaining + count, realized = 0
          student.packageSize = newContracted;
          student.lessonsCompleted = 0;

          // Optional payment record
          const amount = parseFloat(node.querySelector('#rc-amount').value) || 0;
          const dueDate = node.querySelector('#rc-due').value || todayStr();
          const payStatus = node.querySelector('#rc-pay-status').value || 'pending';
          if (amount > 0) {
            const typeLabel = mode === 'single' ? 'Aula avulsa' : mode === 'package' ? `Pacote ${count} aulas` : `${count} aulas`;
            state.payments.push({
              id: uid('pay'),
              studentId: sid,
              description: `${typeLabel} — ${formatDate(todayStr(), { month: 'long', year: 'numeric' })}`,
              amount,
              dueDate,
              status: payStatus,
              type: mode === 'single' ? 'single' : mode === 'package' ? 'package' : 'custom',
              lessonCount: count,
              paidAt: payStatus === 'paid' ? Date.now() : null,
              createdAt: Date.now()
            });
          }

          saveState();
          close();
          rerender();
          toast('ok', 'Aulas cadastradas', `${student.name}: ${newContracted} contratadas · 0 realizadas`);
        });
      }
    });
  }

  function openImportModal() {
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Importar alunos</h3>
          <p class="modal-sub">CSV com colunas: nome, telefone, email, endereco, responsavel, contato_responsavel</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="card" style="background:var(--bg-sunken);padding:12px;margin-bottom:12px">
          <div class="text-sm text-muted mb-sm">Modelo exemplo:</div>
          <pre style="font-family:var(--font-mono);font-size:.8rem;overflow-x:auto;margin:0">nome,telefone,email,endereco,responsavel,contato_responsavel
Pedro Silva,(48)99999-0000,pedro@email.com,Rua X 123,Maria Silva,(48)99999-1111
Ana Souza,(48)98888-0000,ana@email.com,Av Y 456,,</pre>
        </div>
        <button class="btn btn-ghost btn-sm mb-md" id="download-template">${icon('download', 14)} Baixar modelo CSV</button>
        <div class="field">
          <label class="field-label">Cole o CSV aqui ou selecione um arquivo</label>
          <input type="file" accept=".csv,.txt" class="input" id="csv-file" style="margin-bottom:8px" />
          <textarea class="textarea" id="csv-text" rows="8" placeholder="Ou cole o conteúdo CSV diretamente..."></textarea>
        </div>
        <div id="import-preview"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-accent" id="import-confirm">Importar</button>
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {
        node.querySelector('#download-template').addEventListener('click', () => {
          const csv = 'nome,telefone,email,endereco,responsavel,contato_responsavel\nPedro Silva,(48)99999-0000,pedro@email.com,Rua X 123,Maria Silva,(48)99999-1111\n';
          const blob = new Blob([csv], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'modelo-alunos.csv'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });

        node.querySelector('#csv-file').addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (ev) => {
            node.querySelector('#csv-text').value = ev.target.result;
          };
          reader.readAsText(file);
        });

        node.querySelector('#import-confirm').addEventListener('click', () => {
          const text = node.querySelector('#csv-text').value.trim();
          if (!text) { showError('Vazio', 'Forneça um CSV para importar.'); return; }
          try {
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            const header = lines[0].split(',').map(h => h.trim().toLowerCase());
            const students = [];
            for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(',').map(c => c.trim());
              const row = {};
              header.forEach((h, j) => row[h] = cols[j] || '');
              if (!row.nome) continue;
              students.push({
                id: uid('student'),
                name: row.nome,
                phone: row.telefone || '',
                email: row.email || '',
                address: row.endereco || '',
                guardianName: row.responsavel || '',
                guardianPhone: row.contato_responsavel || '',
                guardianIsFinancial: !!row.responsavel,
                active: true,
                favorite: false,
                customPricing: false,
                packageSize: state.settings.packageSize,
                lessonsCompleted: 0,
                packagePrice: null,
                singleLessonPrice: null,
                group: null,
                createdAt: Date.now()
              });
            }
            if (students.length === 0) {
              showError('Nenhum registro válido', 'Verifique o formato do arquivo.'); return;
            }
            state.students.push(...students);
            saveState();
            close();
            rerender();
            toast('ok', `${students.length} aluno(s) importado(s)`);
          } catch (e) {
            showError('Erro ao importar', 'Formato inválido. Verifique o CSV.');
          }
        });
      }
    });
  }

  // =========================================================
  // GROUPS VIEW
  // =========================================================

  function renderGroups() {
    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Grupos / Turmas</h2>
          <div class="section-sub">Agrupe alunos que costumam ter aula juntos</div>
        </div>
        <button class="btn btn-accent" id="new-group">${icon('plus', 14)} Novo grupo</button>
      </div>

      ${state.groups.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('users', 24)}</div>
          <h3>Nenhum grupo cadastrado</h3>
          <p>Crie grupos para facilitar o agendamento coletivo.</p>
        </div>
      ` : `
        <div class="entity-grid">
          ${state.groups.map(g => {
            const members = g.studentIds.map(id => findById('students', id)).filter(Boolean);
            return `
            <div class="entity-card" data-group-id="${g.id}">
              <div class="entity-card-header">
                <div style="flex:1">
                  <div class="entity-name">${escapeHtml(g.name)}</div>
                  <div class="text-sm text-muted">${members.length} aluno(s)</div>
                </div>
              </div>
              <div class="entity-meta">
                ${members.slice(0, 4).map(m => `
                  <div class="flex items-center gap-sm" style="padding:3px 0">
                    <div class="avatar" style="width:24px;height:24px;font-size:.7rem">${escapeHtml(initials(m.name))}</div>
                    <span>${escapeHtml(m.name)}</span>
                  </div>
                `).join('')}
                ${members.length > 4 ? `<div class="text-sm text-muted">+${members.length - 4} outro(s)</div>` : ''}
              </div>
            </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
    `;
  }

  function bindGroupsEvents() {
    $('#new-group')?.addEventListener('click', () => openGroupModal());
    $$('[data-group-id]').forEach(el => {
      el.addEventListener('click', () => openGroupModal(el.dataset.groupId));
    });
  }

  function openGroupModal(groupId) {
    const group = groupId ? state.groups.find(g => g.id === groupId) : null;
    const isNew = !group;
    const selected = group ? [...group.studentIds] : [];

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Novo grupo' : 'Editar grupo'}</h3>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Nome do grupo</label>
          <input class="input" id="g-name" value="${escapeHtml(group?.name || '')}" placeholder="Ex: Turma de Manhã" />
        </div>
        <div class="field">
          <label class="field-label">Alunos</label>
          <div id="g-students"></div>
        </div>
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="g-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="g-save">Salvar</button>
      </div>
    `, {
      onMount: (node, close) => {
        mountMultiSelect(node.querySelector('#g-students'),
          state.students.filter(s => s.active).map(s => ({ id: s.id, label: s.name })),
          selected, 'Buscar alunos...');
        node.querySelector('#g-save').addEventListener('click', () => {
          const name = node.querySelector('#g-name').value.trim();
          if (!name) { showError('Nome obrigatório', 'Informe o nome do grupo.'); return; }
          const data = { id: group?.id || uid('group'), name, studentIds: [...selected] };
          if (isNew) state.groups.push(data);
          else Object.assign(group, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Grupo criado' : 'Grupo atualizado');
        });
        if (!isNew) {
          node.querySelector('#g-delete').addEventListener('click', () => {
            showConfirm('Excluir grupo?', 'Esta ação não pode ser desfeita.', () => {
              state.groups = state.groups.filter(g => g.id !== group.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Grupo excluído');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  // =========================================================
  // REPLACEMENTS (REPOSIÇÕES)
  // =========================================================

  function renderReplacements() {
    const pending = state.lessons.filter(l => l.status === 'canceled' && l.needsReplacement && !l.replacementSchedule);
    const scheduled = state.lessons.filter(l => l.status === 'canceled' && l.needsReplacement && l.replacementSchedule);
    const done = state.lessons.filter(l => l.isReplacement);

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Reposições</h2>
          <div class="section-sub">Aulas canceladas que precisam ser repostas</div>
        </div>
      </div>

      <div class="kanban">
        <div class="kanban-col">
          <div class="kanban-col-header">
            <div class="kanban-col-title">Pendentes</div>
            <span class="badge badge-warn">${pending.length}</span>
          </div>
          ${pending.length === 0 ? '<div class="text-sm text-subtle" style="padding:8px;text-align:center">Nenhuma pendente</div>' : pending.map(l => renderReposCard(l, 'pending')).join('')}
        </div>
        <div class="kanban-col">
          <div class="kanban-col-header">
            <div class="kanban-col-title">Reagendadas</div>
            <span class="badge badge-info">${scheduled.length}</span>
          </div>
          ${scheduled.length === 0 ? '<div class="text-sm text-subtle" style="padding:8px;text-align:center">Nenhuma reagendada</div>' : scheduled.map(l => renderReposCard(l, 'scheduled')).join('')}
        </div>
        <div class="kanban-col">
          <div class="kanban-col-header">
            <div class="kanban-col-title">Concluídas</div>
            <span class="badge badge-ok">${done.length}</span>
          </div>
          ${done.length === 0 ? '<div class="text-sm text-subtle" style="padding:8px;text-align:center">Nenhuma reposição concluída</div>' : done.map(l => renderReposCard(l, 'done')).join('')}
        </div>
      </div>
    </div>
    `;
  }

  function renderReposCard(l, status) {
    const students = l.studentIds.map(id => findById('students', id)?.name).filter(Boolean).join(', ');
    const room = findById('rooms', l.roomId);
    return `
    <div class="kanban-card" data-repo-lesson="${l.id}">
      <div class="card-title-s">${escapeHtml(students)}</div>
      <div class="card-meta">${formatDate(l.date)} · ${l.start} · ${escapeHtml(room?.name || '')}</div>
      ${l.cancelReason ? `<div class="text-xs text-muted mt-sm">${escapeHtml(l.cancelReason)}</div>` : ''}
      ${status === 'pending' ? `<button class="btn btn-sm btn-accent mt-sm" data-schedule-repos="${l.id}" style="width:100%">${icon('cal', 12)} Reagendar</button>` : ''}
    </div>
    `;
  }

  function bindReplacementsEvents() {
    $$('[data-repo-lesson]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-schedule-repos]')) return;
        openLessonDetailModal(el.dataset.repoLesson);
      });
    });
    $$('[data-schedule-repos]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const lesson = findById('lessons', b.dataset.scheduleRepos);
        if (!lesson) return;
        openReposScheduleModal(lesson);
      });
    });
  }

  function openReposScheduleModal(originalLesson) {
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Reagendar reposição</h3>
          <p class="modal-sub">Criar nova aula de reposição em outra data/horário</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Nova data</label>
          <input type="date" class="input" id="rp-date" value="${todayStr()}" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Início</label>
            <input type="time" class="input" id="rp-start" value="${originalLesson.start}" />
          </div>
          <div class="field">
            <label class="field-label">Fim</label>
            <input type="time" class="input" id="rp-end" value="${originalLesson.end}" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Sala</label>
          <select class="select" id="rp-room">
            ${state.rooms.filter(r => r.active).map(r => `<option value="${r.id}" ${r.id === originalLesson.roomId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-accent" id="rp-save">Criar reposição</button>
      </div>
    `, {
      onMount: (node, close) => {
        node.querySelector('#rp-save').addEventListener('click', () => {
          const date = node.querySelector('#rp-date').value;
          const start = node.querySelector('#rp-start').value;
          const end = node.querySelector('#rp-end').value;
          const roomId = node.querySelector('#rp-room').value;
          if (!date || !start || !end || !roomId) { showError('Dados incompletos', 'Preencha todos os campos.'); return; }
          const conflict = checkLessonConflict({
            roomId, teacherIds: originalLesson.teacherIds, studentIds: originalLesson.studentIds,
            date, start, end
          });
          if (conflict) { showError('Conflito', conflict.message); return; }
          const newLesson = {
            ...originalLesson,
            id: uid('l'),
            date, start, end, roomId,
            status: 'scheduled',
            isReplacement: true,
            replacementOf: originalLesson.id,
            cancelReason: null,
            needsReplacement: false,
            createdAt: Date.now()
          };
          state.lessons.push(newLesson);
          originalLesson.replacementSchedule = newLesson.id;
          saveState();
          close();
          rerender();
          toast('ok', 'Reposição agendada', formatDate(date) + ' ' + start);
        });
      }
    });
  }

  // =========================================================
  // MESSAGES / NOTIFICATIONS VIEW
  // =========================================================

  function wasReminderSent(lessonId, studentId, kind = 'lesson') {
    return state.messageLog.some(m =>
      m.studentId === studentId &&
      m.lessonId === lessonId &&
      m.kind === kind
    );
  }

  function markReminderSent(lessonId, studentId, kind = 'lesson', text = '') {
    state.messageLog.push({
      id: uid('msg'),
      studentId, lessonId,
      channel: 'manual',
      text: text || 'Lembrete marcado como enviado',
      kind,
      sentAt: Date.now()
    });
    saveState();
  }

  function renderMessages() {
    const log = [...state.messageLog].sort((a, b) => b.sentAt - a.sentAt).slice(0, 50);

    // Collect pending reminders for tomorrow + renewal
    const tomorrow = addDays(todayStr(), 1);
    const tomorrowLessons = state.lessons
      .filter(l => l.date === tomorrow && l.status !== 'canceled')
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

    // Flatten: one reminder per (lesson, student)
    const lessonReminders = [];
    tomorrowLessons.forEach(l => {
      l.studentIds.forEach(sId => {
        const s = findById('students', sId);
        if (s) lessonReminders.push({ type: 'lesson', lesson: l, student: s });
      });
    });

    const renewalReminders = state.students
      .filter(s => {
        if (!s.active) return false;
        const st = getStudentLessonStatus(s);
        const threshold = state.settings.packageEndThreshold || 1;
        const mode = state.settings.packageEndMode || 'available';
        // 'available' = considers scheduled; 'remaining' = ignores scheduled
        const value = mode === 'remaining' ? st.remaining : st.available;
        return value <= threshold;
      })
      .map(s => ({ type: 'renewal', student: s, status: getStudentLessonStatus(s) }));

    const allReminders = [...lessonReminders, ...renewalReminders];
    const pending = allReminders.filter(r => {
      if (r.type === 'lesson') return !wasReminderSent(r.lesson.id, r.student.id, 'lesson');
      return !wasReminderSent('renewal', r.student.id, 'renewal');
    });
    const sent = allReminders.filter(r => {
      if (r.type === 'lesson') return wasReminderSent(r.lesson.id, r.student.id, 'lesson');
      return wasReminderSent('renewal', r.student.id, 'renewal');
    });

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Mensagens</h2>
          <div class="section-sub">Lembretes pendentes, templates e histórico</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab active" data-mtab="reminders">Lembretes ${pending.length > 0 ? `<span class="badge badge-warn" style="margin-left:6px">${pending.length}</span>` : ''}</button>
        <button class="tab" data-mtab="templates">Templates</button>
        <button class="tab" data-mtab="history">Histórico</button>
      </div>

      <div id="mtab-reminders">
        ${renderRemindersSection(pending, sent)}
      </div>

      <div id="mtab-templates" style="display:none">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">Lembrete de aula</div>
            <div class="card-sub">Variáveis: {aluno}, {data}, {horaInicio}, {horaFim}, {professor}, {sala}</div>
            <div class="field">
              <label class="field-label">Template</label>
              <textarea class="textarea" id="tpl-reminder" rows="6">${escapeHtml(state.settings.whatsappReminderTemplate)}</textarea>
            </div>
            <button class="btn btn-primary btn-sm" id="save-tpl-reminder">Salvar</button>
          </div>

          <div class="card">
            <div class="card-title">Pacote acabando</div>
            <div class="card-sub">Alerta quando o aluno está quase sem aulas</div>
            <div class="grid-2">
              <div class="field">
                <label class="field-label">Modo de contagem</label>
                <select class="select" id="pkg-mode">
                  <option value="available" ${state.settings.packageEndMode === 'available' ? 'selected' : ''}>Disponíveis (considera agendadas)</option>
                  <option value="remaining" ${state.settings.packageEndMode === 'remaining' ? 'selected' : ''}>Restantes no pacote (ignora agendadas)</option>
                </select>
              </div>
              <div class="field">
                <label class="field-label">Alertar quando ≤</label>
                <input type="number" class="input" id="pkg-threshold" value="${state.settings.packageEndThreshold}" min="0" max="5" />
              </div>
            </div>
            <div class="field">
              <label class="field-label">Template (vars: {aluno}, {aulasRestantes})</label>
              <textarea class="textarea" id="tpl-package" rows="4">${escapeHtml(state.settings.whatsappPackageEndTemplate)}</textarea>
            </div>
            <button class="btn btn-primary btn-sm" id="save-tpl-package">Salvar</button>
          </div>

          <div class="card">
            <div class="card-title">Aluno sem aulas</div>
            <div class="card-sub">Para incentivar a contratação de novo pacote. Apenas template — use em "Copiar" quando precisar</div>
            <div class="field">
              <label class="field-label">Template (vars: {aluno}, {pacotePadrao})</label>
              <textarea class="textarea" id="tpl-nolessons" rows="5">${escapeHtml(state.settings.whatsappNoLessonsTemplate || '')}</textarea>
            </div>
            <button class="btn btn-primary btn-sm" id="save-tpl-nolessons">Salvar</button>
          </div>
        </div>
      </div>

      <div id="mtab-history" style="display:none">
        <div class="card">
          <div class="card-title">Histórico de envios</div>
          <div class="card-sub">Últimas ${log.length} mensagens registradas</div>
          ${log.length === 0 ? `
            <div class="text-sm text-subtle" style="padding:12px 0">Nenhum envio registrado ainda.</div>
          ` : `
            <div class="table-wrap mt-sm">
              <table class="data">
                <thead><tr><th>Aluno</th><th>Tipo</th><th>Canal</th><th>Mensagem</th><th>Quando</th></tr></thead>
                <tbody>
                  ${log.map(m => {
                    const student = findById('students', m.studentId);
                    const kindLabel = m.kind === 'renewal' ? 'Renovação' : 'Lembrete de aula';
                    return `<tr>
                      <td>${escapeHtml(student?.name || '—')}</td>
                      <td><span class="badge badge-neutral">${kindLabel}</span></td>
                      <td><span class="badge badge-info">${m.channel === 'whatsapp' ? 'WhatsApp' : m.channel === 'clipboard' ? 'Copiado' : 'Manual'}</span></td>
                      <td class="text-muted text-sm">${escapeHtml(m.text.slice(0, 50))}${m.text.length > 50 ? '...' : ''}</td>
                      <td class="text-muted text-sm">${relativeTime(m.sentAt)}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    </div>
    `;
  }

  function renderRemindersSection(pending, sent) {
    const renderItem = (r, done) => {
      if (r.type === 'lesson') {
        const room = findById('rooms', r.lesson.roomId);
        const teachers = r.lesson.teacherIds.map(id => findById('teachers', id)?.name).filter(Boolean).join(', ');
        return `
          <div class="today-item" style="border-left-color:${room?.color || '#c6833a'};${done ? 'opacity:.55' : ''}">
            <div class="time-block" style="width:110px">
              <strong style="font-size:.85rem">Amanhã</strong>
              <span style="display:block;font-size:.72rem">${r.lesson.start} — ${r.lesson.end}</span>
            </div>
            <div class="info">
              <div class="title">${escapeHtml(r.student.name)} ${done ? '<span class="badge badge-ok badge-dot" style="margin-left:6px">Enviado</span>' : ''}</div>
              <div class="sub">${escapeHtml(teachers)} · ${escapeHtml(room?.name || '')}</div>
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-sm btn-ghost" data-rem-wa data-rem-lesson="${r.lesson.id}" data-rem-student="${r.student.id}" title="Enviar WhatsApp">${icon('wa', 14)}</button>
              <button class="btn btn-sm btn-ghost" data-rem-copy data-rem-lesson="${r.lesson.id}" data-rem-student="${r.student.id}" title="Copiar">${icon('copy', 14)}</button>
              ${done ? `
                <button class="btn btn-sm btn-ghost" data-rem-unmark data-rem-lesson="${r.lesson.id}" data-rem-student="${r.student.id}" title="Desmarcar">${icon('close', 14)}</button>
              ` : `
                <button class="btn btn-sm btn-accent" data-rem-mark data-rem-kind="lesson" data-rem-lesson="${r.lesson.id}" data-rem-student="${r.student.id}" title="Marcar como enviado">${icon('check', 14)}</button>
              `}
            </div>
          </div>
        `;
      }
      // renewal
      return `
        <div class="today-item" style="border-left-color:var(--rose);${done ? 'opacity:.55' : ''}">
          <div class="time-block" style="width:110px">
            <strong style="font-size:.85rem;color:var(--rose-ink)">Renovação</strong>
            <span style="display:block;font-size:.72rem">${r.status.available} disponível(is)</span>
          </div>
          <div class="info">
            <div class="title">${escapeHtml(r.student.name)} ${done ? '<span class="badge badge-ok badge-dot" style="margin-left:6px">Enviado</span>' : ''}</div>
            <div class="sub">${r.status.used}/${r.status.total} aulas realizadas · ${r.status.scheduled} agendadas</div>
          </div>
          <div class="flex gap-sm">
            <button class="btn btn-sm btn-ghost" data-rem-wa-renewal data-rem-student="${r.student.id}" title="Enviar WhatsApp">${icon('wa', 14)}</button>
            <button class="btn btn-sm btn-ghost" data-rem-copy-renewal data-rem-student="${r.student.id}" title="Copiar">${icon('copy', 14)}</button>
            ${done ? `
              <button class="btn btn-sm btn-ghost" data-rem-unmark data-rem-lesson="renewal" data-rem-student="${r.student.id}" title="Desmarcar">${icon('close', 14)}</button>
            ` : `
              <button class="btn btn-sm btn-accent" data-rem-mark data-rem-kind="renewal" data-rem-lesson="renewal" data-rem-student="${r.student.id}" title="Marcar como enviado">${icon('check', 14)}</button>
            `}
          </div>
        </div>
      `;
    };

    return `
      <div class="grid-2" style="align-items:start">
        <div class="card">
          <div class="flex items-center justify-between mb-md">
            <div>
              <div class="card-title">Pendentes</div>
              <div class="card-sub">Lembretes a enviar</div>
            </div>
            <span class="badge badge-warn">${pending.length}</span>
          </div>
          ${pending.length === 0 ? `
            <div class="text-sm text-subtle" style="padding:20px;text-align:center">
              ${icon('check', 18)}<br/>
              Todos os lembretes foram enviados.
            </div>
          ` : `<div class="today-list">${pending.map(r => renderItem(r, false)).join('')}</div>`}
        </div>

        <div class="card">
          <div class="flex items-center justify-between mb-md">
            <div>
              <div class="card-title">Enviados</div>
              <div class="card-sub">Confirmados como enviados</div>
            </div>
            <span class="badge badge-ok">${sent.length}</span>
          </div>
          ${sent.length === 0 ? `
            <div class="text-sm text-subtle" style="padding:20px;text-align:center">Nenhum lembrete confirmado ainda.</div>
          ` : `<div class="today-list">${sent.map(r => renderItem(r, true)).join('')}</div>`}
        </div>
      </div>
    `;
  }

  function bindMessagesEvents() {
    // Tabs
    $$('[data-mtab]').forEach(b => b.addEventListener('click', () => {
      $$('[data-mtab]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.mtab;
      ['reminders', 'templates', 'history'].forEach(t => {
        const el = $(`#mtab-${t}`);
        if (el) el.style.display = tab === t ? '' : 'none';
      });
    }));

    $('#save-tpl-reminder')?.addEventListener('click', () => {
      state.settings.whatsappReminderTemplate = $('#tpl-reminder').value.trim();
      saveState();
      toast('ok', 'Template salvo');
    });
    $('#save-tpl-package')?.addEventListener('click', () => {
      state.settings.whatsappPackageEndTemplate = $('#tpl-package').value.trim();
      state.settings.packageEndThreshold = parseInt($('#pkg-threshold').value, 10) || 1;
      state.settings.packageEndMode = $('#pkg-mode').value || 'available';
      saveState();
      rerender();
      toast('ok', 'Template salvo');
    });

    $('#save-tpl-nolessons')?.addEventListener('click', () => {
      state.settings.whatsappNoLessonsTemplate = $('#tpl-nolessons').value.trim();
      saveState();
      toast('ok', 'Template salvo');
    });

    // Reminder actions — lesson
    $$('[data-rem-wa]').forEach(b => b.addEventListener('click', () => {
      sendWhatsAppReminder(b.dataset.remLesson, b.dataset.remStudent);
    }));
    $$('[data-rem-copy]').forEach(b => b.addEventListener('click', () => {
      copyReminderText(b.dataset.remLesson, b.dataset.remStudent);
    }));
    // Reminder actions — renewal
    $$('[data-rem-wa-renewal]').forEach(b => b.addEventListener('click', () => {
      sendRenewalReminder(b.dataset.remStudent);
    }));
    $$('[data-rem-copy-renewal]').forEach(b => b.addEventListener('click', () => {
      copyRenewalText(b.dataset.remStudent);
    }));
    // Mark sent / unmark
    $$('[data-rem-mark]').forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.remKind;
      const lessonId = b.dataset.remLesson;
      const studentId = b.dataset.remStudent;
      markReminderSent(lessonId, studentId, kind, 'Marcado como enviado manualmente');
      rerender();
      toast('ok', 'Marcado como enviado');
    }));
    $$('[data-rem-unmark]').forEach(b => b.addEventListener('click', () => {
      const lessonId = b.dataset.remLesson;
      const studentId = b.dataset.remStudent;
      state.messageLog = state.messageLog.filter(m => !(m.lessonId === lessonId && m.studentId === studentId));
      saveState();
      rerender();
      toast('info', 'Marcação removida');
    }));
  }

  function buildRenewalText(student) {
    const st = getStudentLessonStatus(student);
    const template = state.settings.whatsappPackageEndTemplate || 'Olá {aluno}! Seu pacote está acabando — você tem {aulasRestantes} aula(s) restante(s).';
    return template
      .replaceAll('{aluno}', student.name)
      .replaceAll('{aulasRestantes}', String(st.available));
  }

  function sendRenewalReminder(studentId) {
    const student = findById('students', studentId);
    if (!student) return;
    const text = buildRenewalText(student);
    const phone = (student.phone || student.guardianPhone || '').replace(/\D/g, '');
    let url;
    if (phone) {
      const withCountry = phone.startsWith('55') ? phone : '55' + phone;
      url = `https://wa.me/${withCountry}?text=${encodeURIComponent(text)}`;
    } else {
      url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    }
    window.open(url, '_blank');
    state.messageLog.push({
      id: uid('msg'), studentId, lessonId: 'renewal', channel: 'whatsapp', text, kind: 'renewal', sentAt: Date.now()
    });
    saveState();
    rerender();
    toast('ok', 'Mensagem aberta no WhatsApp', `Para ${student.name}`);
  }

  function copyRenewalText(studentId) {
    const student = findById('students', studentId);
    if (!student) return;
    const text = buildRenewalText(student);
    navigator.clipboard.writeText(text).then(() => {
      toast('ok', 'Copiado!');
      state.messageLog.push({
        id: uid('msg'), studentId, lessonId: 'renewal', channel: 'clipboard', text, kind: 'renewal', sentAt: Date.now()
      });
      saveState();
      rerender();
    }).catch(() => showError('Erro', 'Não foi possível copiar.'));
  }

  // =========================================================
  // FINANCIAL VIEW
  // =========================================================

  // =========================================================
  // NOTES VIEW — full notes system with blocks, tables, status
  // =========================================================

  const DEFAULT_NOTE_STATUSES = [
    { id: 'draft', label: 'Rascunho', color: '#8a7f72' },
    { id: 'active', label: 'Em andamento', color: '#3a5ea8' },
    { id: 'done', label: 'Concluído', color: '#4a7c3b' },
    { id: 'onhold', label: 'Em espera', color: '#d4a017' },
    { id: 'canceled', label: 'Cancelado', color: '#a83a2e' }
  ];

  function getNoteStatuses() {
    if (!state.noteStatuses || state.noteStatuses.length === 0) {
      state.noteStatuses = [...DEFAULT_NOTE_STATUSES];
    }
    return state.noteStatuses;
  }

  function renderNotes() {
    const filter = appView.filters.notes;
    const categories = state.noteCategories || [];
    const statuses = getNoteStatuses();

    // Filter notes
    let notes = (state.notes || []).filter(n => {
      if (filter.categoryId !== 'all' && n.categoryId !== filter.categoryId) return false;
      if (filter.status !== 'all' && n.status !== filter.status) return false;
      if (filter.search) {
        const q = filter.search.toLowerCase();
        if (!n.title.toLowerCase().includes(q) &&
            !(n.content || '').toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Anotações</h2>
          <div class="section-sub">Blocos de notas e tabelas com categorias e status</div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <button class="btn btn-ghost" id="manage-categories">${icon('gear', 14)} Categorias</button>
          <button class="btn btn-ghost" id="manage-statuses">${icon('flag', 14)} Status</button>
          <button class="btn btn-ghost" id="new-table-note">${icon('grid', 14)} Nova tabela</button>
          <button class="btn btn-accent" id="new-note">${icon('plus', 14)} Nova anotação</button>
        </div>
      </div>

      <div class="flex gap-sm mb-md flex-wrap items-center">
        <div class="chip-filters">
          <button class="chip ${filter.categoryId === 'all' ? 'active' : ''}" data-note-cat="all">Todas <span class="count">${(state.notes || []).length}</span></button>
          ${categories.map(c => {
            const count = (state.notes || []).filter(n => n.categoryId === c.id).length;
            return `<button class="chip ${filter.categoryId === c.id ? 'active' : ''}" data-note-cat="${c.id}" style="${filter.categoryId === c.id ? `background:${c.color};color:white;border-color:${c.color}` : ''}">${escapeHtml(c.name)} <span class="count">${count}</span></button>`;
          }).join('')}
        </div>
        <div style="flex:1"></div>
        <select class="select" id="note-status-filter" style="max-width:180px">
          <option value="all">Todos os status</option>
          ${statuses.map(s => `<option value="${s.id}" ${filter.status === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
        </select>
        <div class="search-global" style="max-width:280px">
          <span class="search-icon">${icon('search', 14)}</span>
          <input class="input" id="note-search" placeholder="Buscar anotações..." value="${escapeHtml(filter.search)}" />
        </div>
      </div>

      ${notes.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('edit', 24)}</div>
          <h3>${(state.notes || []).length === 0 ? 'Nenhuma anotação ainda' : 'Nenhum resultado com esses filtros'}</h3>
          <p>${(state.notes || []).length === 0 ? 'Crie sua primeira anotação ou tabela.' : 'Ajuste os filtros acima.'}</p>
          ${(state.notes || []).length === 0 ? `<button class="btn btn-accent" id="empty-new-note">${icon('plus', 14)} Criar primeira anotação</button>` : ''}
        </div>
      ` : `
        <div class="entity-grid">
          ${notes.map(n => renderNoteCard(n, categories, statuses)).join('')}
        </div>
      `}
    </div>
    `;
  }

  function renderNoteCard(n, categories, statuses) {
    const cat = categories.find(c => c.id === n.categoryId);
    const stat = statuses.find(s => s.id === n.status);
    const isTable = n.type === 'table';
    const preview = isTable
      ? `${(n.tableRows || []).length} linha(s) × ${(n.tableCols || []).length} coluna(s)`
      : (n.content || '').replace(/[#*`]/g, '').slice(0, 160);

    return `
    <div class="entity-card" data-note-id="${n.id}">
      <div class="flex items-center gap-sm mb-sm">
        ${cat ? `<div class="entity-color-dot" style="background:${cat.color}"></div>` : ''}
        <div class="entity-name" style="flex:1">${escapeHtml(n.title || '(sem título)')}</div>
        ${isTable ? `<span class="badge badge-info" title="Tabela">${icon('grid', 10)}</span>` : ''}
      </div>
      <div class="text-sm text-muted" style="min-height:40px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(preview) || '<em>(vazio)</em>'}</div>
      <div class="flex gap-sm mt-md items-center" style="flex-wrap:wrap">
        ${stat ? `<span class="badge" style="background:${stat.color}20;color:${stat.color};border:1px solid ${stat.color}40"><span class="badge-dot" style="background:${stat.color}"></span>${escapeHtml(stat.label)}</span>` : ''}
        ${cat ? `<span class="badge badge-neutral">${escapeHtml(cat.name)}</span>` : ''}
        <div style="flex:1"></div>
        <span class="text-xs text-subtle">${relativeTime(n.updatedAt || n.createdAt)}</span>
      </div>
    </div>
    `;
  }

  function bindNotesEvents() {
    $$('[data-note-cat]').forEach(b => b.addEventListener('click', () => {
      appView.filters.notes.categoryId = b.dataset.noteCat;
      rerender();
    }));
    $('#note-status-filter')?.addEventListener('change', (e) => {
      appView.filters.notes.status = e.target.value;
      rerender();
    });
    $('#note-search')?.addEventListener('input', (e) => {
      appView.filters.notes.search = e.target.value;
      clearTimeout(window.__noteSearchT);
      window.__noteSearchT = setTimeout(() => rerender(), 200);
    });
    $('#new-note')?.addEventListener('click', () => openNoteEditorModal(null, 'note'));
    $('#empty-new-note')?.addEventListener('click', () => openNoteEditorModal(null, 'note'));
    $('#new-table-note')?.addEventListener('click', () => openNoteEditorModal(null, 'table'));
    $('#manage-categories')?.addEventListener('click', () => openNoteCategoriesModal());
    $('#manage-statuses')?.addEventListener('click', () => openNoteStatusesModal());
    $$('[data-note-id]').forEach(el => {
      el.addEventListener('click', () => {
        const n = (state.notes || []).find(x => x.id === el.dataset.noteId);
        if (n) openNoteEditorModal(n.id, n.type || 'note');
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const note = (state.notes || []).find(x => x.id === el.dataset.noteId);
        if (!note) return;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Abrir', icon: 'info', onClick: () => openNoteEditorModal(note.id, note.type || 'note') },
          { label: 'Duplicar', icon: 'copy', onClick: () => {
            const copy = { ...note, id: uid('note'), title: note.title + ' (cópia)', createdAt: Date.now(), updatedAt: Date.now() };
            if (note.tableRows) copy.tableRows = note.tableRows.map(r => ({ ...r, id: uid('row'), cells: { ...(r.cells || {}) } }));
            if (note.tableCols) copy.tableCols = note.tableCols.map(c => ({ ...c, id: uid('col') }));
            state.notes.push(copy);
            saveState(); rerender();
            toast('ok', 'Anotação duplicada');
          }},
          { divider: true },
          { label: 'Excluir', icon: 'trash', danger: true, onClick: () => {
            showConfirm('Excluir anotação?', 'Esta ação não pode ser desfeita.', () => {
              state.notes = state.notes.filter(n => n.id !== note.id);
              saveState(); rerender();
              toast('ok', 'Anotação excluída');
            }, 'Excluir', 'danger');
          }}
        ]);
      });
    });
  }

  function openNoteEditorModal(noteId, type = 'note') {
    const note = noteId ? (state.notes || []).find(n => n.id === noteId) : null;
    const isNew = !note;
    const actualType = note ? (note.type || 'note') : type;
    const categories = state.noteCategories || [];
    const statuses = getNoteStatuses();

    const defaultCols = [
      { id: uid('col'), name: 'Item' },
      { id: uid('col'), name: 'Descrição' },
      { id: uid('col'), name: 'Status' }
    ];

    let tableCols = note?.tableCols ? [...note.tableCols] : [...defaultCols];
    let tableRows = note?.tableRows ? note.tableRows.map(r => ({ ...r })) : [];

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? (actualType === 'table' ? 'Nova tabela' : 'Nova anotação') : 'Editar anotação'}</h3>
          <p class="modal-sub">${actualType === 'table' ? 'Tabela com colunas e linhas editáveis' : 'Bloco de texto com categoria e status'}</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="Fechar">${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Título</label>
          <input class="input" id="note-title" value="${escapeHtml(note?.title || '')}" placeholder="${actualType === 'table' ? 'Ex: Controle de pagamentos' : 'Ex: Ideias de aula'}" />
        </div>

        <div class="grid-2">
          <div class="field">
            <label class="field-label">Categoria</label>
            <select class="select" id="note-category">
              <option value="">Sem categoria</option>
              ${categories.map(c => `<option value="${c.id}" ${note?.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">Status</label>
            <select class="select" id="note-status">
              <option value="">Sem status</option>
              ${statuses.map(s => `<option value="${s.id}" ${note?.status === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        ${actualType === 'table' ? `
          <div class="tabs" style="margin-bottom:12px">
            <button class="tab active" data-ntab="table" type="button">${icon('grid', 12)} Tabela</button>
            <button class="tab" data-ntab="structure" type="button">${icon('gear', 12)} Estrutura</button>
          </div>
          <div id="ntab-table">
            <div id="note-table-wrap" style="overflow-x:auto"></div>
            <button class="btn btn-ghost btn-sm mt-sm" id="add-row" type="button" style="width:100%;border-style:dashed">${icon('plus', 12)} Adicionar linha</button>
          </div>
          <div id="ntab-structure" style="display:none">
            <div class="field-hint mb-md">Arraste para reordenar colunas e linhas. Clique no nome para renomear.</div>
            <div class="field">
              <label class="field-label">Colunas</label>
              <div id="note-cols-wrap"></div>
              <button class="btn btn-ghost btn-sm mt-sm" id="add-col" type="button" style="width:100%;border-style:dashed">${icon('plus', 12)} Adicionar coluna</button>
            </div>
          </div>
        ` : `
          <div class="field">
            <label class="field-label">Conteúdo</label>
            <textarea class="textarea" id="note-content" rows="12" placeholder="Escreva suas notas aqui...">${escapeHtml(note?.content || '')}</textarea>
            <div class="field-hint">Suporta texto simples e quebras de linha.</div>
          </div>
        `}
      </div>
      <div class="modal-footer">
        ${!isNew ? '<button class="btn btn-danger" id="note-delete">Excluir</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="note-save">Salvar</button>
      </div>
    `, {
      size: 'lg',
      onMount: (node, close) => {

        // Tab switching (table only)
        if (actualType === 'table') {
          node.querySelectorAll('[data-ntab]').forEach(b => {
            b.addEventListener('click', () => {
              node.querySelectorAll('[data-ntab]').forEach(x => x.classList.remove('active'));
              b.classList.add('active');
              const tab = b.dataset.ntab;
              ['table', 'structure'].forEach(t => {
                const el = node.querySelector(`#ntab-${t}`);
                if (el) el.style.display = tab === t ? '' : 'none';
              });
            });
          });
        }

        const renderCols = () => {
          const wrap = node.querySelector('#note-cols-wrap');
          if (!wrap) return;
          wrap.innerHTML = tableCols.map((c, i) => `
            <div class="flex items-center gap-sm mb-sm" data-col-row="${c.id}" draggable="true" style="padding:6px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface)">
              <span style="cursor:grab;color:var(--ink-subtle);user-select:none" class="drag-handle" title="Arraste para reordenar">⋮⋮</span>
              <span class="text-xs text-subtle" style="font-family:var(--font-mono);min-width:28px">#${i + 1}</span>
              <input class="input" data-col-name="${c.id}" value="${escapeHtml(c.name)}" placeholder="Nome da coluna" style="flex:1" />
              ${tableCols.length > 1 ? `<button class="table-action danger" data-col-rm="${c.id}" type="button" title="Remover coluna">${icon('trash', 12)}</button>` : ''}
            </div>
          `).join('');
          wrap.querySelectorAll('[data-col-name]').forEach(inp => {
            inp.addEventListener('input', (e) => {
              const col = tableCols.find(x => x.id === inp.dataset.colName);
              if (col) col.name = e.target.value;
              renderTable();
            });
          });
          wrap.querySelectorAll('[data-col-rm]').forEach(btn => {
            btn.addEventListener('click', () => {
              const id = btn.dataset.colRm;
              tableCols = tableCols.filter(c => c.id !== id);
              tableRows.forEach(r => { if (r.cells) delete r.cells[id]; });
              renderCols();
              renderTable();
            });
          });
          // Drag-and-drop for col reorder
          attachSortable(wrap, '[data-col-row]', 'data-col-row', (fromId, toId) => {
            const fromIdx = tableCols.findIndex(c => c.id === fromId);
            const toIdx = tableCols.findIndex(c => c.id === toId);
            if (fromIdx < 0 || toIdx < 0) return;
            const [moved] = tableCols.splice(fromIdx, 1);
            tableCols.splice(toIdx, 0, moved);
            renderCols();
            renderTable();
          });
        };

        const renderTable = () => {
          const wrap = node.querySelector('#note-table-wrap');
          if (!wrap) return;
          wrap.innerHTML = `
            <table class="data" style="min-width:${Math.max(400, (tableCols.length + 1) * 150)}px">
              <thead>
                <tr>
                  <th style="width:32px"></th>
                  ${tableCols.map(c => `<th>${escapeHtml(c.name || '(sem nome)')}</th>`).join('')}
                  <th style="width:40px">
                    <button class="table-action" id="header-add-col" type="button" title="Adicionar coluna">${icon('plus', 12)}</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                ${tableRows.length === 0 ? `
                  <tr><td colspan="${tableCols.length + 2}" class="text-center text-muted" style="padding:24px">Nenhuma linha ainda. Clique em "Adicionar linha" abaixo.</td></tr>
                ` : tableRows.map((r, i) => `
                  <tr data-row-id="${r.id}" draggable="true">
                    <td style="cursor:grab;color:var(--ink-subtle);text-align:center;user-select:none" class="drag-handle" title="Arraste para reordenar">⋮⋮</td>
                    ${tableCols.map(c => `
                      <td style="padding:4px">
                        <input class="input" data-cell-row="${r.id}" data-cell-col="${c.id}" value="${escapeHtml((r.cells && r.cells[c.id]) || '')}" placeholder="—" style="border:none;background:transparent" />
                      </td>
                    `).join('')}
                    <td><button class="table-action danger" data-row-rm="${r.id}" type="button" title="Remover linha">${icon('trash', 12)}</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `;
          wrap.querySelectorAll('[data-cell-row]').forEach(inp => {
            inp.addEventListener('input', (e) => {
              const row = tableRows.find(r => r.id === inp.dataset.cellRow);
              if (row) {
                if (!row.cells) row.cells = {};
                row.cells[inp.dataset.cellCol] = e.target.value;
              }
            });
          });
          wrap.querySelectorAll('[data-row-rm]').forEach(btn => {
            btn.addEventListener('click', () => {
              tableRows = tableRows.filter(r => r.id !== btn.dataset.rowRm);
              renderTable();
            });
          });
          wrap.querySelector('#header-add-col')?.addEventListener('click', () => {
            tableCols.push({ id: uid('col'), name: `Coluna ${tableCols.length + 1}` });
            renderCols();
            renderTable();
          });
          // Drag-and-drop for row reorder
          const tbody = wrap.querySelector('tbody');
          if (tbody) {
            attachSortable(tbody, '[data-row-id]', 'data-row-id', (fromId, toId) => {
              const fromIdx = tableRows.findIndex(r => r.id === fromId);
              const toIdx = tableRows.findIndex(r => r.id === toId);
              if (fromIdx < 0 || toIdx < 0) return;
              const [moved] = tableRows.splice(fromIdx, 1);
              tableRows.splice(toIdx, 0, moved);
              renderTable();
            });
          }
        };

        if (actualType === 'table') {
          renderCols();
          renderTable();

          node.querySelector('#add-col').addEventListener('click', () => {
            tableCols.push({ id: uid('col'), name: `Coluna ${tableCols.length + 1}` });
            renderCols();
            renderTable();
          });
          node.querySelector('#add-row').addEventListener('click', () => {
            tableRows.push({ id: uid('row'), cells: {} });
            renderTable();
          });
        }

        node.querySelector('#note-save').addEventListener('click', () => {
          const title = node.querySelector('#note-title').value.trim();
          if (!title) { showError('Título obrigatório', 'Informe um título para a anotação.'); return; }
          const data = {
            id: note?.id || uid('note'),
            type: actualType,
            title,
            categoryId: node.querySelector('#note-category').value || null,
            status: node.querySelector('#note-status').value || null,
            content: actualType === 'note' ? (node.querySelector('#note-content')?.value || '') : '',
            tableCols: actualType === 'table' ? tableCols : undefined,
            tableRows: actualType === 'table' ? tableRows : undefined,
            createdAt: note?.createdAt || Date.now(),
            updatedAt: Date.now()
          };
          if (!state.notes) state.notes = [];
          if (isNew) state.notes.push(data);
          else Object.assign(note, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Anotação criada' : 'Anotação salva');
        });

        if (!isNew) {
          node.querySelector('#note-delete').addEventListener('click', () => {
            showConfirm('Excluir anotação?', 'Esta ação não pode ser desfeita.', () => {
              state.notes = state.notes.filter(n => n.id !== note.id);
              saveState();
              close();
              rerender();
              toast('ok', 'Anotação excluída');
            }, 'Excluir', 'danger');
          });
        }
      }
    });
  }

  function openNoteCategoriesModal() {
    if (!state.noteCategories) state.noteCategories = [];
    const rerenderList = (node) => {
      const list = node.querySelector('#cat-list');
      list.innerHTML = state.noteCategories.length === 0
        ? `<div class="empty-state" style="padding:1.5rem"><p>Nenhuma categoria ainda.</p></div>`
        : state.noteCategories.map(c => `
          <div class="flex items-center gap-sm" style="padding:8px 4px;border-bottom:1px solid var(--line)">
            <div class="entity-color-dot" style="background:${c.color}"></div>
            <input class="input" data-cat-name="${c.id}" value="${escapeHtml(c.name)}" style="flex:1" />
            <button class="table-action danger" data-cat-rm="${c.id}">${icon('trash', 14)}</button>
          </div>
        `).join('');
      list.querySelectorAll('[data-cat-name]').forEach(inp => {
        inp.addEventListener('input', (e) => {
          const c = state.noteCategories.find(x => x.id === inp.dataset.catName);
          if (c) { c.name = e.target.value; saveState(); }
        });
      });
      list.querySelectorAll('[data-cat-rm]').forEach(b => {
        b.addEventListener('click', () => {
          state.noteCategories = state.noteCategories.filter(c => c.id !== b.dataset.catRm);
          saveState();
          rerenderList(node);
        });
      });
    };

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Categorias de anotações</h3>
          <p class="modal-sub">Agrupe anotações por tema ou projeto</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="flex gap-sm mb-md" style="align-items:flex-end">
          <div class="field" style="flex:1;margin:0">
            <label class="field-label">Nome</label>
            <input class="input" id="cat-new-name" placeholder="Ex: Alunos, Planejamento" />
          </div>
          <div class="field" style="margin:0">
            <label class="field-label">Cor</label>
            <input type="color" id="cat-new-color" value="#c6833a" style="width:48px;height:42px;border:1px solid var(--line-strong);border-radius:var(--r-md);cursor:pointer;padding:2px" />
          </div>
          <button class="btn btn-accent" id="cat-add">Adicionar</button>
        </div>
        <div id="cat-list"></div>
      </div>
      <div class="modal-footer">
        <div class="spacer"></div>
        <button class="btn btn-primary" data-close-modal>Fechar</button>
      </div>
    `, {
      onMount: (node) => {
        rerenderList(node);
        node.querySelector('#cat-add').addEventListener('click', () => {
          const name = node.querySelector('#cat-new-name').value.trim();
          const color = node.querySelector('#cat-new-color').value;
          if (!name) { showError('Nome obrigatório', 'Informe o nome da categoria.'); return; }
          state.noteCategories.push({ id: uid('cat'), name, color });
          saveState();
          node.querySelector('#cat-new-name').value = '';
          rerenderList(node);
          toast('ok', 'Categoria criada', name);
        });
      }
    });
  }

  function openNoteStatusesModal() {
    const rerenderList = (node) => {
      const list = node.querySelector('#st-list');
      list.innerHTML = getNoteStatuses().map(s => `
        <div class="flex items-center gap-sm" style="padding:8px 4px;border-bottom:1px solid var(--line)">
          <input type="color" data-st-color="${s.id}" value="${s.color}" style="width:36px;height:32px;border:1px solid var(--line-strong);border-radius:var(--r-sm);cursor:pointer;padding:2px" />
          <input class="input" data-st-label="${s.id}" value="${escapeHtml(s.label)}" style="flex:1" />
          ${state.noteStatuses.length > 1 ? `<button class="table-action danger" data-st-rm="${s.id}">${icon('trash', 14)}</button>` : ''}
        </div>
      `).join('');
      list.querySelectorAll('[data-st-label]').forEach(inp => {
        inp.addEventListener('input', (e) => {
          const s = state.noteStatuses.find(x => x.id === inp.dataset.stLabel);
          if (s) { s.label = e.target.value; saveState(); }
        });
      });
      list.querySelectorAll('[data-st-color]').forEach(inp => {
        inp.addEventListener('input', (e) => {
          const s = state.noteStatuses.find(x => x.id === inp.dataset.stColor);
          if (s) { s.color = e.target.value; saveState(); }
        });
      });
      list.querySelectorAll('[data-st-rm]').forEach(b => {
        b.addEventListener('click', () => {
          state.noteStatuses = state.noteStatuses.filter(s => s.id !== b.dataset.stRm);
          saveState();
          rerenderList(node);
        });
      });
    };

    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>Status de anotações</h3>
          <p class="modal-sub">Personalize os status que suas anotações podem ter</p>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="flex gap-sm mb-md" style="align-items:flex-end">
          <input type="color" id="st-new-color" value="#2d7a6b" style="width:40px;height:42px;border:1px solid var(--line-strong);border-radius:var(--r-md);cursor:pointer;padding:2px" />
          <input class="input" id="st-new-label" placeholder="Ex: Revisar, Urgente..." style="flex:1" />
          <button class="btn btn-accent" id="st-add">Adicionar</button>
        </div>
        <div id="st-list"></div>
      </div>
      <div class="modal-footer">
        <div class="spacer"></div>
        <button class="btn btn-primary" data-close-modal>Fechar</button>
      </div>
    `, {
      onMount: (node) => {
        getNoteStatuses();
        rerenderList(node);
        node.querySelector('#st-add').addEventListener('click', () => {
          const label = node.querySelector('#st-new-label').value.trim();
          const color = node.querySelector('#st-new-color').value;
          if (!label) { showError('Nome obrigatório', 'Informe o nome do status.'); return; }
          state.noteStatuses.push({ id: uid('nst'), label, color });
          saveState();
          node.querySelector('#st-new-label').value = '';
          rerenderList(node);
          toast('ok', 'Status criado', label);
        });
      }
    });
  }

  function renderFinancial() {
    // Compute student contract status
    const studentRows = state.students.filter(s => s.active).map(s => {
      const st = getStudentLessonStatus(s);
      const pricing = getStudentPricing(s);
      const value = pricing.packagePrice;
      let status = 'ok';
      if (st.remaining === 0) status = 'needs-renewal';
      else if (st.available <= 1) status = 'critical';
      return { s, st, value, status };
    });

    const renewalList = studentRows.filter(r => r.status === 'needs-renewal');

    // Payments processing — tag overdue
    const today = todayStr();
    const payments = state.payments.map(p => {
      const effectiveStatus = p.status === 'pending' && p.dueDate < today ? 'overdue' : p.status;
      return { ...p, effectiveStatus };
    });

    const paidPayments = payments.filter(p => p.status === 'paid');
    const pendingPayments = payments.filter(p => p.effectiveStatus === 'pending' || p.effectiveStatus === 'overdue');
    const allPayments = [...payments].sort((a, b) => b.createdAt - a.createdAt);

    // Totals
    const paidTotal = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const pendingTotal = pendingPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const overdueTotal = pendingPayments.filter(p => p.effectiveStatus === 'overdue').reduce((sum, p) => sum + (p.amount || 0), 0);

    // Teacher totals (current month)
    const teacherRows = state.teachers.filter(t => t.active).map(t => {
      const hours = calcTeacherMonthlyHours(t.id);
      const total = hours * (t.hourlyRate || 0);
      return { t, hours, total };
    });

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Financeiro</h2>
          <div class="section-sub">Pagamentos de alunos e professores</div>
        </div>
        <div class="flex gap-sm flex-wrap">
          <button class="btn btn-accent" id="fin-new-payment">${icon('plus', 14)} Cadastrar aulas / cobrança</button>
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric m-teal">
          <div class="metric-label">Recebido</div>
          <div class="metric-value">${formatCurrency(paidTotal)}</div>
          <div class="metric-delta">${paidPayments.length} pagamento(s)</div>
        </div>
        <div class="metric m-amber">
          <div class="metric-label">A receber</div>
          <div class="metric-value">${formatCurrency(pendingTotal)}</div>
          <div class="metric-delta">${pendingPayments.length} pendente(s)</div>
        </div>
        <div class="metric m-rose">
          <div class="metric-label">Vencidos</div>
          <div class="metric-value">${formatCurrency(overdueTotal)}</div>
          <div class="metric-delta">${pendingPayments.filter(p => p.effectiveStatus === 'overdue').length} atrasado(s)</div>
        </div>
        <div class="metric">
          <div class="metric-label">Precisa renovar</div>
          <div class="metric-value">${renewalList.length}</div>
          <div class="metric-delta">aluno(s) sem saldo</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab ${appView.financialTab === 'all' ? 'active' : ''}" data-ftab="all">Tudo</button>
        <button class="tab ${appView.financialTab === 'paid' ? 'active' : ''}" data-ftab="paid">Pagos</button>
        <button class="tab ${appView.financialTab === 'pending' ? 'active' : ''}" data-ftab="pending">Pendentes / Atrasados</button>
        <button class="tab ${appView.financialTab === 'renewal' ? 'active' : ''}" data-ftab="renewal">Precisam renovar</button>
        <button class="tab ${appView.financialTab === 'teachers' ? 'active' : ''}" data-ftab="teachers">Professores</button>
      </div>

      <div id="ftab-all" style="display:${appView.financialTab === 'all' ? '' : 'none'}">${renderPaymentsTable(allPayments, 'all')}</div>
      <div id="ftab-paid" style="display:${appView.financialTab === 'paid' ? '' : 'none'}">${renderPaymentsTable(paidPayments, 'paid')}</div>
      <div id="ftab-pending" style="display:${appView.financialTab === 'pending' ? '' : 'none'}">${renderPaymentsTable(pendingPayments, 'pending')}</div>

      <div id="ftab-renewal" style="display:${appView.financialTab === 'renewal' ? '' : 'none'}">
        ${renewalList.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">${icon('check', 24)}</div>
            <h3>Nenhum aluno precisa renovar</h3>
            <p>Todos os alunos ativos têm saldo de aulas disponível.</p>
          </div>
        ` : `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Aluno</th><th>Contratadas</th><th>Realizadas</th><th>Valor do pacote</th><th>Ação</th></tr></thead>
              <tbody>
                ${renewalList.map(r => `
                  <tr>
                    <td><strong>${escapeHtml(r.s.name)}</strong></td>
                    <td>${r.st.total}</td>
                    <td>${r.st.used}</td>
                    <td>${formatCurrency(r.value)}</td>
                    <td>
                      <button class="btn btn-sm btn-accent" data-renew-student="${r.s.id}">${icon('repeat', 12)} Renovar</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div id="ftab-teachers" style="display:${appView.financialTab === 'teachers' ? '' : 'none'}">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Professor</th><th>Horas no mês</th><th>Valor/hora</th><th>Total devido</th><th>Forma de pagamento</th></tr></thead>
            <tbody>
              ${teacherRows.map(r => `
                <tr data-teacher-id="${r.t.id}" style="cursor:pointer">
                  <td><strong>${escapeHtml(r.t.name)}</strong></td>
                  <td>${r.hours.toFixed(1)}h</td>
                  <td>${formatCurrency(r.t.hourlyRate || 0)}</td>
                  <td><strong>${formatCurrency(r.total)}</strong></td>
                  <td>${escapeHtml(r.t.paymentMethod || '—')}${r.t.paymentMethod === 'PIX' && r.t.pixKey ? ` · ${escapeHtml(r.t.pixKey)}` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    `;
  }

  function renderPaymentsTable(payments, kind) {
    if (payments.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('money', 24)}</div>
          <h3>Nenhum ${kind === 'paid' ? 'pagamento registrado' : kind === 'pending' ? 'pendente ou atrasado' : 'registro ainda'}</h3>
          <p>Cadastre aulas com valor para gerar cobranças aqui.</p>
        </div>
      `;
    }
    return `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Aluno</th><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Ação</th></tr></thead>
          <tbody>
            ${payments.map(p => {
              const student = findById('students', p.studentId);
              let badge;
              if (p.status === 'paid') badge = '<span class="badge badge-ok badge-dot">Pago</span>';
              else if (p.effectiveStatus === 'overdue') badge = '<span class="badge badge-danger badge-dot">Vencido</span>';
              else badge = '<span class="badge badge-warn badge-dot">Pendente</span>';
              return `
                <tr data-payment-id="${p.id}">
                  <td><strong>${escapeHtml(student?.name || '—')}</strong></td>
                  <td class="text-muted">${escapeHtml(p.description || '—')}</td>
                  <td><strong>${formatCurrency(p.amount || 0)}</strong></td>
                  <td>${formatDate(p.dueDate, { day: '2-digit', month: '2-digit', year: 'numeric' })}</td>
                  <td>${badge}</td>
                  <td>
                    ${p.status === 'pending' ? `
                      <button class="btn btn-sm btn-ghost" data-pay-mark="${p.id}" title="Marcar pago">Marcar pago</button>
                    ` : `
                      <button class="btn btn-sm btn-ghost" data-pay-unmark="${p.id}" title="Desmarcar">Reabrir</button>
                    `}
                    <button class="table-action danger" data-pay-delete="${p.id}" title="Excluir">${icon('trash', 12)}</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function bindFinancialEvents() {
    $$('[data-ftab]').forEach(b => b.addEventListener('click', () => {
      $$('[data-ftab]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.ftab;
      appView.financialTab = tab;
      ['all', 'paid', 'pending', 'renewal', 'teachers'].forEach(t => {
        const el = $(`#ftab-${t}`);
        if (el) el.style.display = tab === t ? '' : 'none';
      });
    }));

    $('#fin-new-payment')?.addEventListener('click', () => openRenewContractModal());

    $$('[data-renew-student]').forEach(b => b.addEventListener('click', () => {
      openRenewContractModal(b.dataset.renewStudent);
    }));

    $$('[data-pay-mark]').forEach(b => b.addEventListener('click', () => {
      const pay = state.payments.find(p => p.id === b.dataset.payMark);
      if (!pay) return;
      pay.status = 'paid';
      pay.paidAt = Date.now();
      saveState();
      rerender();
      toast('ok', 'Pagamento confirmado');
    }));

    $$('[data-pay-unmark]').forEach(b => b.addEventListener('click', () => {
      const pay = state.payments.find(p => p.id === b.dataset.payUnmark);
      if (!pay) return;
      pay.status = 'pending';
      pay.paidAt = null;
      saveState();
      rerender();
      toast('info', 'Cobrança reaberta');
    }));

    $$('[data-pay-delete]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.payDelete;
      showConfirm('Excluir cobrança?', 'Esta ação não pode ser desfeita.', () => {
        state.payments = state.payments.filter(p => p.id !== id);
        saveState();
        rerender();
        toast('ok', 'Cobrança excluída');
      }, 'Excluir', 'danger');
    }));

    $$('[data-payment-id]').forEach(el => {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pay = state.payments.find(p => p.id === el.dataset.paymentId);
        if (!pay) return;
        const student = findById('students', pay.studentId);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Abrir ficha do aluno', icon: 'user', disabled: !student, onClick: () => openStudentModal(pay.studentId) },
          { divider: true },
          pay.status === 'pending'
            ? { label: 'Marcar como pago', icon: 'check', onClick: () => { pay.status = 'paid'; pay.paidAt = Date.now(); saveState(); rerender(); toast('ok', 'Pagamento confirmado'); } }
            : { label: 'Reabrir cobrança', icon: 'repeat', onClick: () => { pay.status = 'pending'; pay.paidAt = null; saveState(); rerender(); toast('info', 'Cobrança reaberta'); } },
          { label: 'Duplicar cobrança', icon: 'copy', onClick: () => {
            state.payments.push({ ...pay, id: uid('pay'), status: 'pending', paidAt: null, createdAt: Date.now(), dueDate: todayStr() });
            saveState(); rerender();
            toast('ok', 'Cobrança duplicada');
          }},
          { divider: true },
          { label: 'Excluir cobrança', icon: 'trash', danger: true, onClick: () => {
            showConfirm('Excluir cobrança?', 'Esta ação não pode ser desfeita.', () => {
              state.payments = state.payments.filter(p => p.id !== pay.id);
              saveState(); rerender();
              toast('ok', 'Cobrança excluída');
            }, 'Excluir', 'danger');
          }}
        ]);
      });
    });

    $$('[data-student-id]').forEach(el => el.addEventListener('click', () => openStudentModal(el.dataset.studentId)));
    $$('[data-teacher-id]').forEach(el => el.addEventListener('click', () => openTeacherModal(el.dataset.teacherId)));
  }

  // =========================================================
  // REPORTS VIEW
  // =========================================================

  function renderReports() {
    const today = todayStr();
    // Last 4 weeks lessons per week
    const weeks = [];
    for (let i = 3; i >= 0; i--) {
      const ws = addDays(startOfWeek(today), -i * 7);
      const we = addDays(ws, 6);
      const count = state.lessons.filter(l => l.date >= ws && l.date <= we && l.status !== 'canceled').length;
      weeks.push({ label: formatDate(ws, { day: '2-digit', month: 'short' }), count });
    }
    const maxWeek = Math.max(1, ...weeks.map(w => w.count));

    // Room occupancy (last 30 days)
    const thirtyDaysAgo = addDays(today, -30);
    const workDaysInPeriod = 30 * state.settings.workDays.length / 7;
    const workMinPerDay = timeToMinutes(state.settings.workEnd) - timeToMinutes(state.settings.workStart);
    const roomOccupancy = state.rooms.filter(r => r.active).map(r => {
      const lessons = state.lessons.filter(l => l.roomId === r.id && l.date >= thirtyDaysAgo && l.date <= today && l.status !== 'canceled');
      const totalMin = lessons.reduce((s, l) => s + (timeToMinutes(l.end) - timeToMinutes(l.start)), 0);
      const pct = workDaysInPeriod > 0 ? (totalMin / (workDaysInPeriod * workMinPerDay)) * 100 : 0;
      return { r, lessons: lessons.length, pct: Math.min(100, pct) };
    });

    const completedCount = state.lessons.filter(l => l.status === 'done').length;
    const canceledCount = state.lessons.filter(l => l.status === 'canceled').length;
    const totalFinal = completedCount + canceledCount;
    const completionRate = totalFinal > 0 ? (completedCount / totalFinal) * 100 : 0;
    const cancellationRate = totalFinal > 0 ? (canceledCount / totalFinal) * 100 : 0;

    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Relatórios</h2>
          <div class="section-sub">Análises e métricas do sistema</div>
        </div>
        <button class="btn btn-ghost" id="backup-btn">${icon('download', 14)} Backup dos dados</button>
      </div>

      <div class="metrics-grid">
        <div class="metric">
          <div class="metric-label">Taxa de conclusão</div>
          <div class="metric-value">${completionRate.toFixed(1)}%</div>
          <div class="metric-delta">${completedCount} de ${totalFinal}</div>
        </div>
        <div class="metric m-rose">
          <div class="metric-label">Taxa de cancelamento</div>
          <div class="metric-value">${cancellationRate.toFixed(1)}%</div>
          <div class="metric-delta">${canceledCount} canceladas</div>
        </div>
        <div class="metric m-teal">
          <div class="metric-label">Aulas totais</div>
          <div class="metric-value">${state.lessons.length}</div>
          <div class="metric-delta">${state.lessons.filter(l => l.status === 'scheduled').length} agendadas</div>
        </div>
        <div class="metric m-amber">
          <div class="metric-label">Tempo médio de aluno</div>
          <div class="metric-value">${calcAvgStudentTenure()}</div>
          <div class="metric-delta">dias</div>
        </div>
      </div>

      <div class="dashboard-grid">
        <div class="card">
          <div class="card-title">Aulas por semana (últimas 4)</div>
          <div class="chart-container">
            <div class="bar-chart">
              ${weeks.map(w => `
                <div class="bar">
                  <div class="bar-fill" style="height:${(w.count / maxWeek) * 100}%">
                    <span class="bar-value">${w.count}</span>
                  </div>
                  <div class="bar-label">${w.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Ocupação das salas (30 dias)</div>
          <div class="card-sub">Percentual de uso do horário comercial</div>
          ${roomOccupancy.map(ro => `
            <div style="margin:12px 0">
              <div class="flex justify-between mb-sm">
                <div class="flex items-center gap-sm">
                  <div class="entity-color-dot" style="background:${ro.r.color}"></div>
                  <span style="font-weight:500">${escapeHtml(ro.r.name)}</span>
                </div>
                <span class="text-muted text-sm">${ro.pct.toFixed(0)}% · ${ro.lessons} aulas</span>
              </div>
              <div style="height:6px;background:var(--bg-sunken);border-radius:99px;overflow:hidden">
                <div style="height:100%;background:${ro.r.color};width:${ro.pct}%;transition:width .4s"></div>
              </div>
            </div>
          `).join('') || '<div class="text-sm text-subtle">Nenhuma sala ativa</div>'}
        </div>
      </div>

      <div class="card mt-lg">
        <div class="card-title">Horas por professor (mês atual)</div>
        <div class="table-wrap mt-sm">
          <table class="data">
            <thead><tr><th>Professor</th><th>Aulas concluídas</th><th>Horas</th><th>Valor</th></tr></thead>
            <tbody>
              ${state.teachers.filter(t => t.active).map(t => {
                const now = new Date();
                const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                const monthly = state.lessons.filter(l => l.teacherIds.includes(t.id) && l.status === 'done' && l.date.startsWith(ym));
                const hours = calcTeacherMonthlyHours(t.id);
                return `<tr>
                  <td><strong>${escapeHtml(t.name)}</strong></td>
                  <td>${monthly.length}</td>
                  <td>${hours.toFixed(1)}h</td>
                  <td>${formatCurrency(hours * (t.hourlyRate || 0))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    `;
  }

  function calcAvgStudentTenure() {
    const actives = state.students.filter(s => s.active && s.createdAt);
    if (actives.length === 0) return '0';
    const now = Date.now();
    const avgMs = actives.reduce((sum, s) => sum + (now - s.createdAt), 0) / actives.length;
    return Math.round(avgMs / (1000 * 60 * 60 * 24));
  }

  function bindReportsEvents() {
    $('#backup-btn')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tutoragenda-backup-${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('ok', 'Backup gerado', 'Arquivo JSON salvo localmente');
    });
  }

  // =========================================================
  // SETTINGS VIEW
  // =========================================================

  const SHORTCUT_LABELS = {
    newLesson: { title: 'Novo agendamento', sub: 'Abre o modal de criar aula' },
    search: { title: 'Busca global', sub: 'Foca no campo de busca no topo' },
    prevPeriod: { title: 'Período anterior', sub: 'No calendário: volta 1 semana/dia/mês' },
    nextPeriod: { title: 'Próximo período', sub: 'No calendário: avança 1 semana/dia/mês' },
    closeModal: { title: 'Fechar modal', sub: 'Fecha o modal aberto mais recente' },
    goDashboard: { title: 'Ir para o início', sub: 'Navega para o dashboard' },
    goCalendar: { title: 'Ir para o calendário', sub: 'Navega para o calendário' },
    goStudents: { title: 'Ir para alunos', sub: 'Navega para a lista de alunos' },
    toggleTheme: { title: 'Alternar tema', sub: 'Troca entre modo claro e escuro' },
    toggleZoom: { title: 'Modo zoom no calendário', sub: 'Ativa/desativa o modo de zoom e pan' }
  };

  function renderShortcutRows(shortcuts) {
    return Object.keys(SHORTCUT_LABELS).map(key => {
      const lbl = SHORTCUT_LABELS[key];
      const current = shortcuts[key] || '—';
      return `
        <div class="shortcut-row">
          <div class="shortcut-desc">
            <div class="title">${escapeHtml(lbl.title)}</div>
            <div class="sub">${escapeHtml(lbl.sub)}</div>
          </div>
          <button class="kbd" data-shortcut-key="${key}" title="Clique para gravar">${escapeHtml(current)}</button>
        </div>
      `;
    }).join('');
  }

  function renderSettings() {
    const s = state.settings;
    const palettes = [
      { id: 'parchment', name: 'Pergaminho', colors: ['#f8f5ef', '#c6833a', '#2d7a6b', '#1a1612'] },
      { id: 'paper', name: 'Papel', colors: ['#fafafa', '#111111', '#555555', '#888888'] },
      { id: 'sky', name: 'Céu', colors: ['#f1f5fb', '#3a5ea8', '#7aa0db', '#0f1d33'] },
      { id: 'sage', name: 'Sálvia', colors: ['#f3f6f1', '#2d7a6b', '#8cbe77', '#1a2418'] },
      { id: 'rose', name: 'Rosa', colors: ['#faf3f3', '#b8425c', '#e97a92', '#1f1112'] }
    ];
    const fonts = [
      { id: 'default', label: 'Padrão', className: 'ft-default' },
      { id: 'sans', label: 'Sans', className: 'ft-sans' },
      { id: 'system', label: 'Sistema', className: 'ft-system' },
      { id: 'dyslexia', label: 'Dislexia', className: 'ft-dyslexia' }
    ];
    const currentFont = s.fontFamily || 'default';
    const currentPalette = s.palette || 'parchment';
    return `
    <div>
      <div class="section-header">
        <div>
          <h2>Configurações</h2>
          <div class="section-sub">Personalize o sistema de acordo com suas necessidades</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab active" data-stab="general">Geral</button>
        <button class="tab" data-stab="brand">Tema e marca</button>
        <button class="tab" data-stab="shortcuts">Atalhos</button>
        <button class="tab" data-stab="users">Usuários</button>
        <button class="tab" data-stab="data">Dados</button>
      </div>

      <div id="stab-general">
        <div class="card mb-md">
          <div class="card-title">Expediente</div>
          <div class="card-sub">Define o intervalo visível no calendário e bloqueia agendamentos fora do horário</div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label">Início do expediente</label>
              <input type="time" class="input" id="set-work-start" value="${s.workStart}" />
            </div>
            <div class="field">
              <label class="field-label">Fim do expediente</label>
              <input type="time" class="input" id="set-work-end" value="${s.workEnd}" />
            </div>
          </div>
          <div class="field">
            <label class="field-label">Dias de trabalho</label>
            <div class="day-chips" id="set-workdays">
              ${[0,1,2,3,4,5,6].map(d => `
                <button class="day-chip ${s.workDays.includes(d) ? 'active' : ''}" data-workday="${d}">${dowLabel(d, false)}</button>
              `).join('')}
            </div>
            <div class="field-hint">Dias não selecionados aparecem atenuados no calendário mas ainda aceitam agendamento.</div>
          </div>
        </div>

        <div class="card mb-md">
          <div class="card-title">Intervalo</div>
          <div class="card-sub">Horário bloqueado para agendamentos em todos os dias (ex: almoço)</div>
          <div class="switch-row">
            <div class="switch-info">
              <div class="title">Ativar intervalo</div>
              <div class="desc">Quando ativo, impede agendamentos no horário configurado</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-break-enabled" ${s.breakEnabled ? 'checked' : ''} />
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="grid-2" id="break-times" style="${s.breakEnabled ? '' : 'display:none'}">
            <div class="field">
              <label class="field-label">Início do intervalo</label>
              <input type="time" class="input" id="set-break-start" value="${s.breakStart}" />
            </div>
            <div class="field">
              <label class="field-label">Fim do intervalo</label>
              <input type="time" class="input" id="set-break-end" value="${s.breakEnd}" />
            </div>
          </div>
        </div>

        <div class="card mb-md">
          <div class="card-title">Aulas e pacotes</div>
          <div class="card-sub">Valores padrão aplicados quando o aluno não tem configuração individual</div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label">Duração padrão da aula (minutos)</label>
              <input type="number" class="input" id="set-duration" value="${s.lessonDuration}" min="15" step="5" />
            </div>
            <div class="field">
              <label class="field-label">Aulas por pacote</label>
              <input type="number" class="input" id="set-pkg-size" value="${s.packageSize}" min="1" />
            </div>
            <div class="field">
              <label class="field-label">Valor do pacote padrão</label>
              <input type="number" class="input" id="set-pkg-price" value="${s.packagePrice}" step="0.01" />
            </div>
            <div class="field">
              <label class="field-label">Valor da aula avulsa padrão</label>
              <input type="number" class="input" id="set-single-price" value="${s.singleLessonPrice}" step="0.01" />
            </div>
          </div>
          <button class="btn btn-primary" id="save-general">Salvar alterações</button>
        </div>
      </div>

      <div id="stab-brand" style="display:none">
        <div class="card mb-md">
          <div class="card-title">Identidade visual</div>
          <div class="card-sub">Personalize o nome e a cor do sistema</div>
          <div class="field">
            <label class="field-label">Nome do sistema</label>
            <input class="input" id="set-brand-name" value="${escapeHtml(s.brand.name)}" />
          </div>
          <div class="field">
            <label class="field-label">Cor principal</label>
            <div id="set-brand-colors"></div>
          </div>
          <div class="switch-row">
            <div class="switch-info">
              <div class="title">Tema escuro</div>
              <div class="desc">Alterna entre modo claro e escuro</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-dark" ${s.theme === 'dark' ? 'checked' : ''} />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="card mb-md">
          <div class="card-title">Paleta de cores</div>
          <div class="card-sub">Altera o tom de fundo e dos textos do sistema</div>
          <div class="palette-tiles">
            ${palettes.map(p => `
              <div class="palette-tile ${currentPalette === p.id ? 'active' : ''}" data-palette-id="${p.id}">
                <div class="palette-preview">
                  ${p.colors.map(c => `<div style="background:${c}"></div>`).join('')}
                </div>
                <div class="tile-label">${escapeHtml(p.name)}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card mb-md">
          <div class="card-title">Fonte do sistema</div>
          <div class="card-sub">Escolha a tipografia que preferir</div>
          <div class="font-tiles">
            ${fonts.map(f => `
              <div class="font-tile ${f.className} ${currentFont === f.id ? 'active' : ''}" data-font-id="${f.id}">
                <div class="sample">Aa</div>
                <div class="sample-label">${escapeHtml(f.label)}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card mb-md">
          <div class="flex gap-sm">
            <button class="btn btn-primary" id="save-brand">Salvar alterações visuais</button>
            <button class="btn btn-ghost" id="restore-default">Restaurar padrão</button>
          </div>
        </div>
      </div>

      <div id="stab-shortcuts" style="display:none">
        <div class="card mb-md">
          <div class="card-title">Atalhos de teclado</div>
          <div class="card-sub">Clique em uma tecla para gravar um novo atalho. Pressione Esc para cancelar.</div>
          ${renderShortcutRows(s.shortcuts)}
          <div class="flex gap-sm mt-md">
            <button class="btn btn-ghost" id="reset-shortcuts">Restaurar atalhos padrão</button>
          </div>
          <div class="field-hint mt-md">
            <strong>Formato:</strong> teclas únicas (ex: <code>n</code>), modificadores (ex: <code>Ctrl+k</code>) ou sequências (ex: <code>g d</code> — pressione g, depois d).
          </div>
        </div>
      </div>

      <div id="stab-users" style="display:none">
        <div class="card mb-md">
          <div class="flex items-center justify-between mb-md">
            <div>
              <div class="card-title">Usuários do sistema</div>
              <div class="card-sub">Gerencie quem pode acessar o painel</div>
            </div>
            <button class="btn btn-accent btn-sm" id="new-user">${icon('plus', 14)} Novo usuário</button>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Usuário</th><th>E-mail</th><th>Telefone</th><th>Papel</th><th></th></tr></thead>
              <tbody>
                ${state.users.map(u => `
                  <tr>
                    <td><strong>${escapeHtml(u.username)}</strong></td>
                    <td class="text-muted">${escapeHtml(u.email || '—')}</td>
                    <td class="text-muted">${escapeHtml(u.phone || '—')}</td>
                    <td><span class="badge badge-info">${u.role === 'admin' ? 'Administrador' : 'Usuário'}</span></td>
                    <td>
                      <button class="table-action" data-edit-user="${u.id}">${icon('edit', 14)}</button>
                      ${state.users.length > 1 ? `<button class="table-action danger" data-rm-user="${u.id}">${icon('trash', 14)}</button>` : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div id="stab-data" style="display:none">
        <div class="card mb-md">
          <div class="card-title">Exportar / Importar</div>
          <div class="card-sub">Backup completo dos dados do sistema</div>
          <div class="flex gap-sm mt-md flex-wrap">
            <button class="btn btn-primary" id="data-export">${icon('download', 14)} Exportar backup (JSON)</button>
            <label class="btn btn-ghost" style="cursor:pointer">
              ${icon('upload', 14)} Importar backup
              <input type="file" accept=".json" id="data-import" style="display:none" />
            </label>
          </div>
        </div>

        <div class="card mb-md" style="border-color:var(--danger);background:var(--danger-soft)">
          <div class="card-title" style="color:var(--danger-ink)">Zona de perigo</div>
          <div class="card-sub" style="color:var(--danger-ink)">Ações destrutivas que não podem ser desfeitas</div>
          <button class="btn btn-danger mt-md" id="data-reset">${icon('trash', 14)} Apagar todos os dados</button>
        </div>
      </div>
    </div>
    `;
  }

  function bindSettingsEvents() {
    $$('[data-stab]').forEach(b => b.addEventListener('click', () => {
      $$('[data-stab]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.stab;
      ['general', 'brand', 'shortcuts', 'users', 'data'].forEach(t => {
        const el = $(`#stab-${t}`);
        if (el) el.style.display = tab === t ? '' : 'none';
      });
    }));

    // Workdays
    $$('[data-workday]').forEach(b => b.addEventListener('click', () => {
      const d = parseInt(b.dataset.workday, 10);
      const idx = state.settings.workDays.indexOf(d);
      if (idx >= 0) state.settings.workDays.splice(idx, 1);
      else state.settings.workDays.push(d);
      state.settings.workDays.sort();
      saveState();
      b.classList.toggle('active');
    }));

    // Break toggle
    $('#set-break-enabled')?.addEventListener('change', (e) => {
      state.settings.breakEnabled = e.target.checked;
      const times = $('#break-times');
      if (times) times.style.display = e.target.checked ? '' : 'none';
      saveState();
    });

    $('#save-general')?.addEventListener('click', () => {
      state.settings.workStart = $('#set-work-start').value;
      state.settings.workEnd = $('#set-work-end').value;
      state.settings.lessonDuration = parseInt($('#set-duration').value, 10) || 60;
      state.settings.packageSize = parseInt($('#set-pkg-size').value, 10) || 4;
      state.settings.packagePrice = parseFloat($('#set-pkg-price').value) || 0;
      state.settings.singleLessonPrice = parseFloat($('#set-single-price').value) || 0;
      const bs = $('#set-break-start'); if (bs) state.settings.breakStart = bs.value;
      const be = $('#set-break-end'); if (be) state.settings.breakEnd = be.value;
      // Validate break inside work hours
      if (state.settings.breakEnabled) {
        if (timeToMinutes(state.settings.breakStart) >= timeToMinutes(state.settings.breakEnd)) {
          showError('Intervalo inválido', 'O fim do intervalo deve ser maior que o início.'); return;
        }
      }
      saveState();
      toast('ok', 'Configurações salvas');
      rerender();
    });

    // Brand color via new color picker
    let selectedBrandColor = state.settings.brand.primaryColor;
    const brandColorMount = $('#set-brand-colors');
    if (brandColorMount) {
      mountColorPicker(brandColorMount, selectedBrandColor, (c) => { selectedBrandColor = c; });
    }

    // Palette tiles
    $$('[data-palette-id]').forEach(tile => {
      tile.addEventListener('click', () => {
        $$('[data-palette-id]').forEach(x => x.classList.remove('active'));
        tile.classList.add('active');
        state.settings.palette = tile.dataset.paletteId;
        saveState();
        applyTheme();
      });
    });

    // Font tiles
    $$('[data-font-id]').forEach(tile => {
      tile.addEventListener('click', () => {
        $$('[data-font-id]').forEach(x => x.classList.remove('active'));
        tile.classList.add('active');
        state.settings.fontFamily = tile.dataset.fontId;
        saveState();
        applyTheme();
      });
    });

    $('#set-dark')?.addEventListener('change', (e) => {
      state.settings.theme = e.target.checked ? 'dark' : 'light';
      saveState();
      rerender();
    });

    $('#save-brand')?.addEventListener('click', () => {
      state.settings.brand.name = $('#set-brand-name').value.trim() || 'TutorAgenda';
      state.settings.brand.primaryColor = selectedBrandColor;
      saveState();
      toast('ok', 'Identidade visual atualizada');
      rerender();
    });

    $('#restore-default')?.addEventListener('click', () => {
      showConfirm(
        'Restaurar padrão do sistema',
        'Você tem certeza que deseja restaurar temas, cores, fonte e paleta ao padrão do sistema?',
        () => {
          state.settings.brand = { name: 'TutorAgenda', primaryColor: '#c6833a', logoDataUrl: null };
          state.settings.theme = 'light';
          state.settings.palette = 'parchment';
          state.settings.fontFamily = 'default';
          saveState();
          rerender();
          toast('ok', 'Aparência restaurada ao padrão');
        },
        'Restaurar'
      );
    });

    // Shortcut recording
    let recordingKey = null;
    $$('[data-shortcut-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (recordingKey && recordingKey !== btn.dataset.shortcutKey) {
          // Cancel previous recording
          const prev = $(`[data-shortcut-key="${recordingKey}"]`);
          if (prev) {
            prev.classList.remove('recording');
            prev.textContent = state.settings.shortcuts[recordingKey] || '—';
          }
        }
        recordingKey = btn.dataset.shortcutKey;
        btn.classList.add('recording');
        btn.textContent = 'Pressione...';
      });
    });

    // Global listener for shortcut recording (attaches once per render, removed on navigation)
    const shortcutRecordHandler = (e) => {
      if (!recordingKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        const btn = $(`[data-shortcut-key="${recordingKey}"]`);
        if (btn) {
          btn.classList.remove('recording');
          btn.textContent = state.settings.shortcuts[recordingKey] || '—';
        }
        recordingKey = null;
        return;
      }
      // Build shortcut string
      const mods = [];
      if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey && e.key.length > 1) mods.push('Shift');
      let key = e.key;
      if (key === ' ') key = 'Space';
      if (key.length === 1) key = key.toLowerCase();
      // Don't accept modifier-only presses
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return;
      const shortcut = mods.length ? `${mods.join('+')}+${key}` : key;
      state.settings.shortcuts[recordingKey] = shortcut;
      saveState();
      const btn = $(`[data-shortcut-key="${recordingKey}"]`);
      if (btn) {
        btn.classList.remove('recording');
        btn.textContent = shortcut;
      }
      toast('ok', 'Atalho atualizado', `${SHORTCUT_LABELS[recordingKey].title}: ${shortcut}`);
      recordingKey = null;
    };
    document.addEventListener('keydown', shortcutRecordHandler, true);

    $('#reset-shortcuts')?.addEventListener('click', () => {
      showConfirm(
        'Restaurar atalhos padrão',
        'Tem certeza que quer restaurar todos os atalhos de teclado ao padrão?',
        () => {
          state.settings.shortcuts = {
            newLesson: 'n', search: 'Ctrl+k',
            prevPeriod: 'ArrowLeft', nextPeriod: 'ArrowRight',
            closeModal: 'Escape',
            goDashboard: 'g d', goCalendar: 'g c', goStudents: 'g a',
            toggleTheme: 't', toggleZoom: 'l'
          };
          saveState();
          rerender();
          toast('ok', 'Atalhos restaurados');
        },
        'Restaurar'
      );
    });

    $('#new-user')?.addEventListener('click', () => openUserModal());
    $$('[data-edit-user]').forEach(b => b.addEventListener('click', () => openUserModal(b.dataset.editUser)));
    $$('[data-rm-user]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.rmUser;
      if (id === state.currentUserId) {
        showError('Ação não permitida', 'Você não pode excluir o usuário com o qual está logado.');
        return;
      }
      showConfirm('Excluir usuário?', 'Esta ação não pode ser desfeita.', () => {
        state.users = state.users.filter(u => u.id !== id);
        saveState();
        rerender();
        toast('ok', 'Usuário excluído');
      }, 'Excluir', 'danger');
    }));

    $('#data-export')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tutoragenda-backup-${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('ok', 'Backup exportado');
    });

    $('#data-import')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target.result);
          showConfirm(
            'Importar dados?',
            'Isto substituirá TODOS os dados atuais. Tem certeza?',
            () => {
              Object.assign(state, imported);
              state.sessionActive = true;
              state.currentUserId = imported.currentUserId || state.users[0]?.id;
              saveState();
              rerender();
              toast('ok', 'Dados importados com sucesso');
            },
            'Importar e substituir',
            'danger'
          );
        } catch (err) {
          showError('Arquivo inválido', 'Não foi possível ler o arquivo JSON.');
        }
      };
      reader.readAsText(file);
    });

    $('#data-reset')?.addEventListener('click', () => {
      showConfirm(
        'APAGAR TODOS OS DADOS',
        'Esta ação é irreversível. Todos os alunos, professores, salas, aulas e configurações serão permanentemente apagados. Tem certeza absoluta?',
        () => {
          localStorage.removeItem(STORAGE_KEY);
          state = defaultState();
          state.sessionActive = true;
          state.currentUserId = state.users[0].id;
          saveState();
          rerender();
          toast('warn', 'Todos os dados foram apagados');
        },
        'Apagar tudo',
        'danger'
      );
    });
  }

  function openUserModal(userId) {
    const user = userId ? findById('users', userId) : null;
    const isNew = !user;
    openModal(`
      <div class="modal-header">
        <div style="flex:1">
          <h3>${isNew ? 'Novo usuário' : 'Editar usuário'}</h3>
        </div>
        <button class="modal-close" data-close-modal>${icon('close', 18)}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="field-label">Nome de usuário</label>
          <input class="input" id="u-username" value="${escapeHtml(user?.username || '')}" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="field-label">E-mail</label>
            <input type="email" class="input" id="u-email" value="${escapeHtml(user?.email || '')}" />
          </div>
          <div class="field">
            <label class="field-label">Telefone</label>
            <input class="input" id="u-phone" value="${escapeHtml(user?.phone || '')}" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Senha ${!isNew ? '(deixe em branco para manter)' : ''}</label>
          <input type="password" class="input" id="u-password" placeholder="${isNew ? 'Mínimo 4 caracteres' : '••••••••'}" />
        </div>
        <div class="field">
          <label class="field-label">Papel</label>
          <select class="select" id="u-role">
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrador</option>
            <option value="user" ${user?.role === 'user' ? 'selected' : ''}>Usuário</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" data-close-modal>Cancelar</button>
        <button class="btn btn-primary" id="u-save">Salvar</button>
      </div>
    `, {
      onMount: (node, close) => {
        node.querySelector('#u-save').addEventListener('click', () => {
          const username = node.querySelector('#u-username').value.trim();
          const email = node.querySelector('#u-email').value.trim();
          const phone = node.querySelector('#u-phone').value.trim();
          const password = node.querySelector('#u-password').value;
          const role = node.querySelector('#u-role').value;
          if (!username) { showError('Nome obrigatório', 'Informe o nome de usuário.'); return; }
          if (isNew && (!password || password.length < 4)) { showError('Senha inválida', 'Mínimo 4 caracteres.'); return; }
          const duplicate = state.users.find(u => u.id !== user?.id && u.username.toLowerCase() === username.toLowerCase());
          if (duplicate) { showError('Nome de usuário em uso', 'Escolha outro nome.'); return; }
          const data = {
            id: user?.id || uid('user'),
            username, email, phone, role,
            password: password || user?.password,
            createdAt: user?.createdAt || Date.now()
          };
          if (isNew) state.users.push(data);
          else Object.assign(user, data);
          saveState();
          close();
          rerender();
          toast('ok', isNew ? 'Usuário criado' : 'Usuário atualizado');
        });
      }
    });
  }

  // =========================================================
  // INITIAL RENDER & KEYBOARD SHORTCUTS
  // =========================================================

  // Shortcut system — supports single keys, modifiers (Ctrl+k), and chord sequences (g d)
  let chordBuffer = '';
  let chordTimer = null;

  function normalizeKeyEvent(e) {
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && e.key.length > 1) mods.push('Shift');
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return mods.length ? `${mods.join('+')}+${key}` : key;
  }

  function matchesShortcut(evNorm, shortcut) {
    if (!shortcut) return false;
    // Chord: "g d" style — space separated
    if (shortcut.includes(' ')) {
      return chordBuffer === shortcut;
    }
    return evNorm.toLowerCase() === shortcut.toLowerCase();
  }

  document.addEventListener('keydown', (e) => {
    if (!state.sessionActive) return;
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;

    const shortcuts = state.settings.shortcuts || {};
    const evNorm = normalizeKeyEvent(e);

    // Build chord buffer for sequences like "g d"
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      chordBuffer = chordBuffer ? `${chordBuffer} ${e.key.toLowerCase()}` : e.key.toLowerCase();
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => { chordBuffer = ''; }, 800);
    }

    // Match each shortcut
    if (matchesShortcut(evNorm, shortcuts.closeModal)) {
      const lastModal = document.querySelector('.modal-backdrop:last-child');
      if (lastModal) { e.preventDefault(); lastModal.remove(); chordBuffer = ''; return; }
    }
    if (matchesShortcut(evNorm, shortcuts.search)) {
      e.preventDefault();
      const search = $('#global-search');
      if (search) search.focus();
      chordBuffer = '';
      return;
    }
    if (matchesShortcut(evNorm, shortcuts.newLesson)) {
      e.preventDefault();
      openLessonCreateModal();
      chordBuffer = '';
      return;
    }
    if (matchesShortcut(evNorm, shortcuts.toggleTheme)) {
      e.preventDefault();
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      saveState();
      rerender();
      chordBuffer = '';
      return;
    }
    // Toggle zoom mode — only while on calendar route
    if (appView.route === 'calendar' && matchesShortcut(evNorm, shortcuts.toggleZoom)) {
      e.preventDefault();
      toggleZoomMode();
      chordBuffer = '';
      return;
    }
    // + / - for zoom in/out (only when zoom mode is active)
    if (appView.zoomMode && appView.route === 'calendar') {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const content = document.getElementById('calendar-content');
        if (content) {
          const rect = content.getBoundingClientRect();
          zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale * (1 + ZOOM_STEP * 2));
        }
        chordBuffer = '';
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const content = document.getElementById('calendar-content');
        if (content) {
          const rect = content.getBoundingClientRect();
          zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, appView.zoomScale / (1 + ZOOM_STEP * 2));
        }
        chordBuffer = '';
        return;
      }
    }
    if (appView.route === 'calendar') {
      if (matchesShortcut(evNorm, shortcuts.prevPeriod)) {
        const btn = $('[data-cal-nav="prev"]');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
      if (matchesShortcut(evNorm, shortcuts.nextPeriod)) {
        const btn = $('[data-cal-nav="next"]');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
    }
    // Chord-based navigation
    if (matchesShortcut('', '') === false) { /* noop - placeholder */ }
    if (chordBuffer === shortcuts.goDashboard) { appView.route = 'dashboard'; rerender(); chordBuffer = ''; return; }
    if (chordBuffer === shortcuts.goCalendar) { appView.route = 'calendar'; rerender(); chordBuffer = ''; return; }
    if (chordBuffer === shortcuts.goStudents) { appView.route = 'students'; rerender(); chordBuffer = ''; return; }
  });

  // Initial render
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rerender);
  } else {
    rerender();
  }

})();
