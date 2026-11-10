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

  async function acquireEditor() {
    const nb = nbEl();
    if (!nb) return null;
    const active = nb.querySelector('.jp-Cell.jp-mod-active');
    if (active && cellEmpty(active)) return active.querySelector('.cm-content');
    if (clickInsertBelow()) await sleep(180);
    const cells = nb.querySelectorAll('.jp-Cell');
    const last = cells[cells.length - 1];
    return last ? last.querySelector('.cm-content') : null;
  }

  /* ================= 流式生成 ================= */

  /* 围栏过滤器：模型偶尔仍会加 ``` 包裹。为了做到流式，
     头部先缓冲到能判定，尾部保留 20 字符直到结束再收尾。 */
  function makeFilter(out) {
    let head = '';
    let started = false;
    let buf = '';
    const TAIL = 20;

    function emit(s) {
      if (!s) return;
      buf += s;
      if (buf.length > TAIL) {
        out(buf.slice(0, buf.length - TAIL));
        buf = buf.slice(buf.length - TAIL);
      }
    }

    return {
      push(chunk) {
        if (!started) {
          head += chunk;
          if (head.length < 4 && head.indexOf('\n') === -1) return;
          const m = /^```[a-zA-Z0-9_-]*\r?\n/.exec(head);
          started = true;
          if (m) head = head.slice(m[0].length);
          else if (/^```/.test(head)) head = head.replace(/^```[a-zA-Z0-9_-]*/, '');
        } else {
          head += chunk;
        }
        const keep = started ? head : '';
        if (!keep) return;
        head = '';
        emit(keep);
      },
      finish() {
        let rest = buf;
        if (head) rest = (rest || '') + head;
        rest = rest.replace(/\r?\n?```\s*$/, '');
        rest = rest.replace(/^\s*\n+/, '');
        buf = '';
        if (rest) out(rest);
      }
    };
  }

  /* 打字器：从队列消费，走浏览器真实输入管线 */
  async function typeLoop(cm, T) {
    cm.focus();
    let idx = 0;
    let idle = 0;
    while (true) {
      if (T.err) throw T.err;
      const remain = T.text.length - idx;
      if (remain > 0) {
        const step = remain > 800 ? 8 : remain > 300 ? 3 : 1;
        document.execCommand('insertText', false, T.text.slice(idx, idx + step));
        idx += step;
        idle = 0;
        await sleep(7 + Math.random() * 9);
        continue;
      }
      if (T.done) break;
      if (++idle > 400) break; // 20s 无数据，放弃
      await sleep(50);
    }
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

  /* agent 回的是自然语言，这里只留代码：优先取第一个围栏块 */
  function makeCodeFilter(out) {
    let raw = '';
    let mode = 'head';
    let buf = '';
    const TAIL = 20;
    return {
      push(chunk) {
        if (mode === 'done') return;
        raw += chunk;
        if (mode === 'head') {
          const m = /```[a-zA-Z0-9_+-]*\r?\n/.exec(raw);
          if (m) { mode = 'code'; buf = raw.slice(m.index + m[0].length); }
          else if (/^(?:\s*#|\s*(?:import|from)\s|\s*def\s|\s*for\s|\s*print\(|[A-Za-z_]\w*\s*=[^=])/.test(raw)) {
            /* 一眼就是代码，不必等解释文字 */
            mode = 'code'; buf = raw;
          } else if (raw.length > 300) { mode = 'code'; buf = raw; }
          else return;
        } else {
          /* 已经在代码模式：新来的块必须接上，否则只剩切换那一刻的快照 */
          buf += chunk;
        }
        if (mode !== 'code') return;
        const end = buf.indexOf('```');
        if (end >= 0) { if (end) out(buf.slice(0, end)); mode = 'done'; buf = ''; return; }
        if (buf.length > TAIL) { out(buf.slice(0, buf.length - TAIL)); buf = buf.slice(-TAIL); }
      },
      finish() {
        if (mode === 'code' && buf) out(buf.replace(/\r?\n?```[\s\S]*$/, ''));
        buf = '';
      }
    };
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

  /* 走本机桥接（bridge.py）：由它绑到专用会话，逐字吐文本回来 */
  async function streamViaACP(promptText, onDelta, base) {
    base = base.replace(/\/+$/, '');
    const instr = '只输出可以直接运行的 Python 代码，不要任何解释，不要用 ``` 包裹。需求：' + promptText;

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

    const T = { text: '', done: false, err: null };
    const filter = makeCodeFilter(s => { T.text += s; });

    /* 尽早拿到编辑器，让光标先出现在 cell 里 */
    let cm = null;
    let typing = null;

    try {
      cm = await acquireEditor();
      if (!cm) throw new Error('no-editor');
      typing = typeLoop(cm, T).catch(e => { T.err = e; });

      const p = streamCode(promptText, chunk => filter.push(chunk));
      p.then(() => { filter.finish(); T.done = true; })
       .catch(e => { T.err = e; T.done = true; });

      await Promise.all([p.catch(() => {}), typing]);

      if (T.err) throw T.err;

      const got = (cm.textContent || '').replace(/\u200b/g, '').length;
      dbg('done ' + got + '/' + T.text.length);
      return T.text;
    } catch (err) {
      busy = false; /* 先释放，否则无法唤起输入条 */
      const code = err && err.code;
      dbg('err ' + (err && err.message ? err.message : String(err)));
      if (code === 'nokey') { askKey(); }
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

  function askKey() {
    ui.mode = 'key';
    ui.input.value = '';
    ui.input.type = 'password';
    ui.input.placeholder = '粘贴 SiliconFlow API Key，回车保存到本机';
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

    trigger.addEventListener('click', () => {
      if (!getKey()) askKey(); else { taskMode(); open(); }
    });

    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey && e.altKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        if (!getKey()) askKey(); else { taskMode(); open(); }
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
