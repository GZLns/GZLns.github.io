/* invisible-coder : 真实 Jupyter 前端上的隐形生成入口
 *
 * 设计原则
 *   1. 不修改任何 Jupyter 样式，不新增任何可见控件
 *   2. 只操作真实编辑器 DOM（等价于人在单元格里打字），因此排版/高亮/换行
 *      全部由 Jupyter 自己渲染，与手写内容没有任何区别
 *   3. 纯静态：浏览器直连模型 API，不需要任何本地或云端后端
 *   4. key 只存在使用者本机的 localStorage，不进页面、不上传第三方
 */
(function () {
  'use strict';

  const CFG = Object.assign(
    {
      api: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      // 依次尝试：本机桥 → 公网隧道（运行时自动发现）→ 模型
      acp: ['http://127.0.0.1:8799'],
      // 隧道地址与口令，由站点根目录的 bridge.json 提供
      disco: '/bridge.json',
      remote: '',
      bkey: '',
      // 若显式给了自建端点（本地开发用），则走该端点
      endpoint: ''
    },
    window.__INVISIBLE_CODER__ || {}
  );

  const LS_KEY = 'ic.key';
  const LS_MODEL = 'ic.model';

  const SYSTEM = [
    '你在一个 Jupyter notebook 的代码单元里工作。用户用中文描述需求，你输出可以直接运行的 Python 代码。',
    '',
    '要求：',
    '1. 只输出代码本身。不要解释，不要 markdown 代码块标记，不要 ``` 包裹。',
    '2. 风格贴合交互式 notebook：前面的单元已经加载了 pandas / numpy，变量名沿用 df。',
    '3. 每个逻辑段落前用一行中文注释说明意图。',
    '4. 最后一行写成一个表达式（不要 print），让 notebook 直接显示结果。',
    '5. 只用 pandas、numpy、matplotlib、scipy 这类常装库，不要引入其他依赖。',
    '6. 代码长度控制在 5-25 行。'
  ].join('\n');

  /* 诊断只进内存数组，绝不碰 document.title（否则标签页会露馅） */
  const dbg = m => {
    try {
      (window.__icLog = window.__icLog || []).push(m);
      if (window.__icDebug) console.log('[ic]', m);
    } catch (e) {}
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getKey = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } };
  const setKey = k => { try { k ? localStorage.setItem(LS_KEY, k) : localStorage.removeItem(LS_KEY); } catch (e) {} };
  const getModel = () => { try { return localStorage.getItem(LS_MODEL) || CFG.model; } catch (e) { return CFG.model; } };

  /* ================= DOM 定位 ================= */

  const nbEl = () => document.querySelector('.jp-Notebook');

  function cellEmpty(cell) {
    const cm = cell && cell.querySelector('.cm-content');
    if (!cm) return false;
    return (cm.textContent || '').replace(/\u200b/g, '').trim() === '';
  }

  function clickInsertBelow() {
    const wanted = 'insert a cell below';
    const btn = [...document.querySelectorAll('button')].find(b => {
      const t = ((b.title || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
      return t.includes(wanted);
    });
    if (btn) { btn.click(); return true; }
    const footer = document.querySelector('.jp-Notebook-footer');
    if (footer) { footer.click(); return true; }
    return false;
  }

  /* 找一个干净的单元格：优先当前空 cell，其次已有的空 cell，
     都没有就在最后插一个。绝不往有内容的 cell 里追加 */
  async function acquireFreshCell() {
    const nb = nbEl();
    if (!nb) return null;

    const active = nb.querySelector('.jp-Cell.jp-mod-active');
    if (active && cellEmpty(active)) return active.querySelector('.cm-content');

    const cells = [...nb.querySelectorAll('.jp-Cell')];
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cellEmpty(cells[i])) return cells[i].querySelector('.cm-content');
    }

    const before = new Set(cells);
    if (!clickInsertBelow()) return null;
    for (let i = 0; i < 25; i++) {
      await sleep(60);
      const now = [...nb.querySelectorAll('.jp-Cell')];
      const fresh = now.filter(c => !before.has(c));
      if (fresh.length) {
        const c = fresh[fresh.length - 1];
        if (cellEmpty(c)) return c.querySelector('.cm-content');
        /* 新 cell 还没挂上内容区，再等一拍 */
      }
    }
    return null;
  }

  /* ================= 文本抽取 ================= */

  const norm = s => (s || '').replace(/\u200b/g, '').replace(/\r/g, '');

  /* 找到单元格的 CodeMirror 视图：绕开浏览器的括号自动补全与自动缩进 */
  function cmViewOf(cm) {
    const host = cm.closest('.cm-editor') || cm;
    const content = host.querySelector('.cm-content') || cm;
    const v = content && content.cmView && content.cmView.view;
    return (v && v.state && typeof v.dispatch === 'function') ? v : null;
  }

  /* 一次性写入整段代码：直接改 CodeMirror 文档，
     不经过按键管线，也就没有自动补全、自动缩进插进来的多余字符 */
  function pasteCode(cm, code) {
    const v = cmViewOf(cm);
    if (v) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: code },
        selection: { anchor: code.length }
      });
      try { v.focus(); } catch (e) {}
      return norm(cm.innerText || '') !== '' || v.state.doc.length === code.length;
    }
    /* 没有 CM6 视图时的退路 */
    const host = cm.closest('.cm-editor') || cm;
    try { host.focus(); } catch (e) {}
    try { document.execCommand('selectAll'); } catch (e) {}
    try { document.execCommand('insertText', false, code); } catch (e) {}
    const want = norm(code).replace(/\s+/g, '');
    return norm(host.innerText).replace(/\s+/g, '').indexOf(want) === 0;
  }

  /* ================= 本机网关通道（ACP over HTTP） ================= */

  /* ACP 响应既可能是纯 JSON，也可能是 SSE。统一拆成 jsonrpc 消息 */
  function parseRpcBlob(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      try { out.push(JSON.parse(s.slice(5).trim())); } catch (e) {}
    }
    if (!out.length) { try { out.push(JSON.parse(text)); } catch (e) {} }
    return out;
  }

  /* 流式读 SSE，逐个事件交给回调 */
  async function readSSE(res, onMsg) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
        for (const line of block.split(/\r?\n/)) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          try { onMsg(JSON.parse(s.slice(5).trim())); } catch (e) {}
        }
      }
    }
  }

  /* ---------- 全量清洗 ----------
     模型回的是自然语言，这里等整段收完之后一次性切成代码。
     逐行分类 → 取代码区间 → 丢掉夹在中间的说明 → 标点归一 → 去公共缩进 */

  /* 一行是什么：blank / comment / prose / fence / code */
  function classify(t) {
    const s = (t || '').trim();
    if (!s) return 'blank';
    if (/^```/.test(s)) return 'fence';
    if (/^#/.test(s)) return 'comment';
    if (/^(?:import|from|def|class|for|while|if|elif|else|try|except|finally|with|return|print|assert|raise|yield|global|nonlocal|del|pass|break|continue|async|await|lambda|@)/.test(s)) return 'code';
    /* 英文句子式说明："Use a stack to match parentheses." */
    if (/^[A-Z][a-z]+(?:\s+[a-z]+){2,}[.:]/.test(s)) return 'prose';
    if (/^(?:here|sure|certainly|this|note|you|we|it|the|below|above|that|let)\b/i.test(s)) return 'prose';
    /* 非字符串部分含中文：带运算/括号的算代码，否则算说明 */
    const bare = s.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '');
    if (/[\u4e00-\u9fa5]/.test(bare)) return /[=(){}\[\]]/.test(s) ? 'code' : 'prose';
    if (/[=(){}\[\]]|:\s*$/.test(s)) return 'code';
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\(.*\))?$/.test(s)) return 'code';
    if (/[。；！？]$/.test(s)) return 'prose';
    return 'prose';
  }

  /* 全角标点会让 Python 直接 SyntaxError。注释行不动（里面本来就是中文） */
  const FULL = {
    '：': ':', '，': ',', '（': '(', '）': ')', '【': '[', '】': ']', '｛': '{', '｝': '}',
    '；': ';', '！': '!', '？': '?', '“': '"', '”': '"', '‘': "'", '’': "'",
    '＝': '=', '＃': '#', '　': ' '
  };
  function fixPunct(line) {
    if (/^\s*#/.test(line)) return line;
    const bare = line.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '');
    if (/[\u4e00-\u9fa5]/.test(bare)) return line;
    return line.replace(/[：，（）【】｛｝；！？“”‘’＝＃　]/g, c => FULL[c] || c);
  }

  function extractCode(raw) {
    const s = norm(raw || '');
    if (!s.trim()) return '';

    /* 1) 有围栏就用围栏里那一块，最可靠 */
    let body = s;
    const fm = /```[a-zA-Z0-9_+#-]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$)/.exec(s);
    if (fm && fm[1] && fm[1].trim()) {
      body = fm[1];
    } else if (/^```/.test(s.trim())) {
      body = s.replace(/^```[a-zA-Z0-9_+#-]*[ \t]*\r?\n?/, '');
    }

    const lines = body.split('\n');
    const kind = lines.map(classify);

    let first = -1, last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (kind[i] === 'code' || kind[i] === 'comment') { first = i; break; }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (kind[i] === 'code' || kind[i] === 'comment') { last = i; break; }
    }
    if (first < 0 || last < first) return '';

    /* 开头若紧邻中文说明性注释块，一并带上（那本来就是给代码写的注释） */
    while (first > 0 && kind[first - 1] === 'comment') first--;

    const keep = [];
    for (let i = first; i <= last; i++) {
      if (kind[i] === 'prose' || kind[i] === 'fence') { dbg('drop L' + (i + 1)); continue; }
      keep.push(lines[i]);
    }

    let code = keep.join('\n').replace(/[ \t]+$/, '').replace(/\s+$/, '');

    /* 整段被统一缩进（模型常见）会直接 IndentationError，减掉公共缩进 */
    let min = Infinity;
    code.split('\n').forEach(l => {
      if (!l.trim()) return;
      const n = /^[ \t]*/.exec(l)[0].length;
      if (n < min) min = n;
    });
    if (min > 0 && min < Infinity) {
      code = code.split('\n').map(l => l.slice(Math.min(min, l.length))).join('\n');
    }

    code = code.split('\n').map(fixPunct).join('\n');
    code = code.replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    return code;
  }

  /* 公网隧道地址会变，所以每次开工前从站点根目录的 bridge.json 取一次 */
  let _disc = null, _discAt = 0;
  function ensureDiscovered() {
    const now = Date.now();
    if (_disc && now - _discAt < 120000) return _disc;
    _discAt = now;
    _disc = fetch(CFG.disco + '?t=' + now, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && d.url) {
          CFG.remote = String(d.url).replace(/\/+$/, '');
          CFG.bkey = d.key || '';
        }
        return CFG.remote;
      })
      .catch(() => CFG.remote);
    return _disc;
  }

  /* 本地 llama-server（U 盘那套）：页面就由它提供，同源直连，不需要 key */
  function localBases() {
    const h = location.hostname;
    if (h !== '127.0.0.1' && h !== 'localhost') return [];   // 线上站点不探本机，免得被拦
    const out = [];
    if (location.port && /^18\d{3}$/.test(location.port)) out.push(location.origin);
    ['18480', '18481', '18482', '18483', '18490', '18500'].forEach(p => {
      const b = 'http://127.0.0.1:' + p;
      if (out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }

  async function streamViaLocal(promptText, onDelta, base) {
    base = base.replace(/\/+$/, '');

    /* 端口没开就立刻收手，别让主人干等 */
    const g = new AbortController();
    const gt = setTimeout(() => g.abort(), 700);
    let ok = false;
    try {
      const r = await fetch(base + '/v1/models', { signal: g.signal });
      ok = r.ok;
    } catch (e) {
      ok = false;
    } finally {
      clearTimeout(gt);
    }
    if (!ok) throw new Error('local off');

    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), 120000);   // 本地模型首包可能慢
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 120000); };

    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: promptText }
        ],
        max_tokens: 1024,
        temperature: 0.15,
        top_p: 0.9,
        stream: true
      })
    });
    if (!r.ok) { clearTimeout(idle); throw new Error('local ' + r.status); }

    let got = 0;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let carry = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bump();
        carry += dec.decode(value, { stream: true });
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const pl = s.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try {
            const j = JSON.parse(pl);
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (d && d.content) { got += d.content.length; onDelta(d.content); }
          } catch (e) {}
        }
      }
    } finally {
      clearTimeout(idle);
    }
    if (!got) { const e = new Error('local empty'); e.code = 'empty'; throw e; }
    dbg('local ' + got + 'ch');
  }

  /* 走本机桥接（bridge.py）：由它绑到专用会话，逐字吐文本回来 */
  async function streamViaACP(promptText, onDelta, base) {
    base = base.replace(/\/+$/, '');
    const instr = '你现在只做一件事：把需求翻译成可直接运行的 Python 代码。'
      + '输出必须以代码开头，不要任何解释、寒暄、前后说明，不要用 ``` 包裹。需求：' + promptText;

    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), 45000);   // 首包上限
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 120000); };

    let got = 0;
    let chunkN = 0, deltaN = 0, head = '';
    try {
      const hdr = { 'Content-Type': 'application/json' };
      if (CFG.bkey) hdr['X-Bridge-Key'] = CFG.bkey;
      const r = await fetch(base + '/gen', {
        method: 'POST',
        headers: hdr,
        body: JSON.stringify({ text: instr }),
        signal: ac.signal
      });
      if (!r.ok) throw new Error('gen ' + r.status);

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunkN++;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let m;
            try { m = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            if (m.delta) { bump(); got += m.delta.length; deltaN++; if (head.length < 90) head += m.delta; onDelta(m.delta); }
            else if (m.error) {
              if (!got) {
                const e = new Error('gen ' + m.error);
                e.code = 'bridge';
                throw e;
              }
              dbg('gen error ' + m.error);
            }
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const busy = new Error('gen busy');
        busy.code = 'busy';
        throw busy;
      }
      throw e;
    } finally {
      clearTimeout(idle);
    }
    if (!got) {
      const e = new Error('gen empty');
      e.code = 'empty';
      throw e;
    }
    dbg('gen ' + chunkN + 'c/' + deltaN + 'd/' + got + 'ch');
  }

  async function streamCode(promptText, onDelta) {
    /* 本机桥优先，其次公网隧道；都不通才回退直连模型 */
    try { await ensureDiscovered(); } catch (e) {}
    const list = (Array.isArray(CFG.acp) ? CFG.acp.slice() : [CFG.acp]).filter(Boolean);
    if (CFG.remote && list.indexOf(CFG.remote) < 0) list.push(CFG.remote);

    /* 1) 本机桥 / 2) 公网隧道 */
    for (const base of list) {
      try {
        await streamViaACP(promptText, onDelta, base);
        return;
      } catch (e) {
        dbg('acp ' + base + ' -> ' + (e && e.message ? e.message : e));
        /* 端口在、只是忙：换下一个口也一样忙，直接走回退 */
        if (e && e.code === 'busy') break;
      }
    }

    /* 3) 本地模型（如果那台机器上开着），同源、不需要 key */
    for (const base of localBases()) {
      try {
        await streamViaLocal(promptText, onDelta, base);
        return;
      } catch (e) {
        dbg('local ' + base + ' -> ' + (e && e.message ? e.message : e));
      }
    }

    const key = getKey();

    /* 自建端点（本地开发/代理）优先 */
    if (CFG.endpoint) {
      const r = await fetch(CFG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d.code) onDelta(d.code);
      return;
    }

    if (!key) { const e = new Error('nokey'); e.code = 'nokey'; throw e; }

    const res = await fetch(CFG.api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: getModel(),
        stream: true,
        temperature: 0.35,
        max_tokens: 1500,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: promptText }
        ]
      })
    });

    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j.message) msg += ' ' + j.message; } catch (e) {}
      const err = new Error(msg);
      if (res.status === 401 || res.status === 403) err.code = 'nokey';
      throw err;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let carry = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += dec.decode(value, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s || s === 'data: [DONE]') continue;
        if (!s.startsWith('data:')) continue;
        try {
          const j = JSON.parse(s.slice(5).trim());
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) onDelta(d.content);
        } catch (e) {}
      }
    }
  }

  /* ================= 主流程 ================= */

  let busy = false;

  async function run(promptText) {
    if (busy) return null;
    busy = true;
    dbg('run');

    try {
      /* 1) 先把整段回复收完，编辑器一点不动 */
      let raw = '';
      await streamCode(promptText, chunk => { raw += chunk; });
      window.__icRaw = raw;

      /* 2) 一次性切成干净代码 */
      const code = extractCode(raw);
      if (!code) {
        const e = new Error('没认出代码');
        e.code = 'nocode';
        throw e;
      }

      /* 3) 一次性写进一个干净的新单元格 */
      const cm = await acquireFreshCell();
      if (!cm) throw new Error('no-editor');
      await sleep(40);
      pasteCode(cm, code);

      dbg('done ' + code.length + 'ch');
      window.__icLast = { text: code, cell: norm(cm.innerText || '') };
      return code;
    } catch (err) {
      busy = false; /* 先释放，否则无法唤起输入条 */
      const c = err && err.code;
      dbg('err ' + (err && err.message ? err.message : String(err)));
      if (c === 'nokey') { pendingText = promptText; askKey(); }
      else { toast(err && err.message ? err.message : '生成失败'); }
      return null;
    } finally {
      busy = false;
    }
  }

  /* ================= 极简交互层 ================= */

  const CSS = `
  /* ---- 品牌对齐：左上角换成 Jupyter 官方图标与文字 ---- */
  #jp-NotebookLogo > svg{display:none !important}
  #jp-NotebookLogo{display:inline-flex !important;align-items:center;gap:5px;padding-left:5px}
  #jp-NotebookLogo::before{content:'';flex:none;width:23px;height:27px;
    background:url(../jupyter-logo.svg) no-repeat center/contain}
  #jp-NotebookLogo::after{content:'jupyter';font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
    font-size:18px;font-weight:400;color:#4E4E4E;letter-spacing:.1px;line-height:1}
  /* Lite 没有签名信任机制，不显示一个并不成立的状态 */
  .jp-NotebookTrustedStatus{display:none !important}
  /* 内核图标：用 Python 官方图标；PY/WASM 是发行版标识，去掉 */
  .jp-NotebookKernelLogo > :not(img){display:none !important}
  /* ---- 入口 ---- */
  #ic-trigger{position:fixed;right:0;bottom:0;width:56px;height:56px;z-index:99998;cursor:default;
    opacity:0;transition:opacity .3s ease}
  #ic-trigger:hover{opacity:1}
  #ic-trigger::after{content:'';position:absolute;right:18px;bottom:18px;width:6px;height:6px;
    border-radius:50%;background:#bdbdbd;transition:all .25s ease}
  #ic-trigger:hover::after{background:#1976d2;box-shadow:0 0 7px rgba(25,118,210,.45)}
  #ic-bar{position:fixed;left:0;right:0;bottom:0;z-index:99999;height:38px;display:flex;
    align-items:center;gap:10px;padding:0 16px;background:#fff;border-top:1px solid #e0e0e0;
    box-shadow:0 -2px 6px rgba(0,0,0,.06);transform:translateY(101%);
    transition:transform .17s cubic-bezier(.4,0,.2,1);
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
  #ic-bar.open{transform:translateY(0)}
  #ic-in{flex:1 1 auto;background:transparent;border:0;outline:0;color:rgba(0,0,0,.87);
    font-family:menlo,consolas,'DejaVu Sans Mono',monospace;font-size:13px}
  #ic-in::placeholder{color:rgba(0,0,0,.26)}
  #ic-hint{font-size:11px;color:rgba(0,0,0,.26);font-family:system-ui,sans-serif;
    user-select:none;white-space:nowrap}
  #ic-toast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%) translateY(6px);
    z-index:99999;padding:5px 12px;border-radius:3px;background:rgba(0,0,0,.72);color:#fff;
    font-family:system-ui,sans-serif;font-size:11.5px;opacity:0;pointer-events:none;
    transition:opacity .22s ease,transform .22s ease}
  #ic-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  `;

  let mounted = false;
  let ui = {};

  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }

  let pendingText = '';

  function askKey() {
    ui.mode = 'key';
    ui.input.value = '';
    ui.input.type = 'password';
    ui.input.placeholder = '桥没连上，走模型兜底需要 SiliconFlow Key（回车保存）';
    ui.hint.textContent = 'local only';
    open();
  }

  function taskMode() {
    ui.mode = 'task';
    ui.input.type = 'text';
    ui.input.value = '';
    ui.input.placeholder = '…';
    ui.hint.textContent = 'enter';
  }

  function open() {
    if (busy) return;
    ui.bar.classList.add('open');
    ui.input.focus();
  }

  function close() {
    ui.bar.classList.remove('open');
    ui.input.value = '';
    ui.input.blur();
  }

  function mountUI() {
    if (mounted) return;
    mounted = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const trigger = document.createElement('div');
    trigger.id = 'ic-trigger';

    const bar = document.createElement('div');
    bar.id = 'ic-bar';
    bar.innerHTML = '<input id="ic-in" autocomplete="off" spellcheck="false" placeholder="…">' +
                    '<span id="ic-hint">enter</span>';

    const to = document.createElement('div');
    to.id = 'ic-toast';

    document.body.appendChild(trigger);
    document.body.appendChild(bar);
    document.body.appendChild(to);

    ui = {
      trigger,
      bar,
      toast: to,
      input: bar.querySelector('#ic-in'),
      hint: bar.querySelector('#ic-hint'),
      mode: 'task'
    };

    taskMode();

    /* 主入口不问 key：桥通了就不需要 key，只有真的回退到模型时才问 */
    trigger.addEventListener('click', () => { taskMode(); open(); });

    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey && e.altKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        taskMode(); open();
      } else if (k === 'l') {
        e.preventDefault();
        askKey();
      }
    });

    ui.input.addEventListener('keydown', e => {
      if (e.key === 'Escape') return close();
      if (e.key !== 'Enter') return;
      const text = ui.input.value.trim();
      if (!text) return close();

      if (ui.mode === 'key') {
        setKey(text);
        close();
        taskMode();
        toast('已保存在本机');
        /* 如果是刚才因为缺 key 中断的任务，补跑一次 */
        const p = pendingText;
        pendingText = '';
        if (p) run(p);
        return;
      }
      close();
      run(text);
    });

    window.invisibleCoder = {
      open: () => { taskMode(); open(); },
      close,
      run,
      resetKey: () => { setKey(''); toast('已清除本机 key'); },
      cfg: CFG,
      discover: ensureDiscovered
    };

    /* 内核名：保留真实技术栈，只对齐 "Python 3 (…)" 的写法 */
    const fixKernel = () => {
      document.querySelectorAll('.jp-ToolbarButtonComponent-label').forEach(el => {
        const t = (el.textContent || '').trim();
        if (/^Python \(/.test(t)) el.textContent = 'Python 3 (Pyodide)';
      });
      /* 内核图标换成 Python 官方图标 */
      let want = '';
      try { want = new URL('../python-logo.svg', location.href).href; } catch (e) { return; }
      document.querySelectorAll('.jp-NotebookKernelLogo img').forEach(img => {
        if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      });
    };

    /* 标签页标题：普通 notebook 显示的是一份本地文件的名字，不是发行版名 */
    const fixTitle = () => {
      const t = document.title || '';
      if (!/JupyterLite/.test(t)) return;
      const rest = t.replace(/JupyterLite/g, '').replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, '');
      document.title = rest || 'Untitled3';
    };

    fixKernel(); fixTitle();
    let brandTick = null;
    new MutationObserver(() => {
      if (brandTick) return;
      brandTick = setTimeout(() => { brandTick = null; fixKernel(); fixTitle(); }, 400);
    }).observe(document.body, { childList: true, subtree: true });

    /* <title> 节点被换掉时兜住 */
    const watchTitle = () => {
      const el = document.querySelector('title');
      if (el) new MutationObserver(fixTitle).observe(el, { childList: true, characterData: true, subtree: true });
    };
    watchTitle();

    dbg('mounted');

    /* 提前把隧道地址捞到手，第一次按 Ctrl+Alt+K 时不用等 */
    try { ensureDiscovered(); } catch (e) {}

    /* 开发自测：?ictest=<需求> */
    const t = new URLSearchParams(location.search).get('ictest');
    if (t) setTimeout(() => run(t), 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountUI);
  } else {
    mountUI();
  }
})();
