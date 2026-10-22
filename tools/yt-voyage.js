/* 盐田船期公众查询取数器（易物流盐田 www.156yt.cn）
 * ------------------------------------------------------------------
 * 为什么必须用真实浏览器：
 *   1) 站点有 JS 反爬挑战页（curl 直连只拿到 986 字节的跳转脚本）；
 *   2) voyQuery.jsp 在没有 156yt 会话时会被服务端弹回「公共信息服务」首页，
 *      所以必须先访问一次首页拿到会话，再从站内进入船期页 —— 只有浏览器能保持这个上下文；
 *   3) 表单要用 .click() 提交，不能用 form.submit()（后者会销毁上下文导致断连）。
 * 本模块自带 CDP 的最小 WebSocket 实现，因此整个项目依然是零 npm 依赖。
 * 用法：
 *   作为模块：require('./yt-voyage').query({ship:'YM WORTHINESS', date:'20261023'})
 *   作为命令行：node yt-voyage.js --ship "YM WORTHINESS" [--date 20261023] [--voy 003W]
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_URL = 'https://www.156yt.cn/publicInfoService/index.action';
const VOY_URL  = 'https://www.156yt.cn/pqs_revision/pages/jsp/voyQuery.jsp?loginVerifyCode=';
const FORM_ACTION = 'https://www.156yt.cn/pqs_revision/pages/jsp/voyQuery.jsp?modify=query';

let PORT = 9334;
const DEBUG = !!process.env.YT_DEBUG;
function dbg(s) { if (DEBUG) console.log('[yt-voyage] ' + s); }
let chrome = null;        // 子进程
let proc = null;          // 句柄
let idleTimer = null;
let busy = false;         // 取数串行锁
const IDLE_KILL_MS = 10 * 60 * 1000;

/* ---------------- 本机 Chrome 定位 ---------------- */
function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

/* ---------------- 最小 WebSocket 客户端（够用即可） ---------------- */
function wsConnect(url) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    let done = false;
    const conn = { sock: sock, id: 0, pend: new Map(), onEvent: null, closed: false };
    sock.setNoDelay(true);
    sock.on('error', function (e) { if (!done) { done = true; reject(e); } });
    sock.on('close', function () { conn.closed = true; conn.pend.clear(); });

    let buf = Buffer.alloc(0);
    let up = false;
    sock.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('latin1');
        buf = buf.slice(i + 4);
        if (head.indexOf('101') < 0) { sock.destroy(); if (!done) { done = true; reject(new Error('WS handshake failed')); } return; }
        up = true;
        if (!done) { done = true; resolve(conn); }
      }
      // 解析帧
      for (;;) {
        if (buf.length < 2) break;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0x9) { connSend(conn, payload, 0xA); continue; }      // ping -> pong
        if (op === 0x8) { try { sock.end(); } catch (e) {} continue; }
        if (op === 0x1 || op === 0x2) {
          if (payload.length > 8 * 1024 * 1024) continue;
          let msg = null;
          try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
          if (msg.id && conn.pend.has(msg.id)) { const f = conn.pend.get(msg.id); conn.pend.delete(msg.id); f(msg); }
          else if (msg.method && conn.onEvent) { try { conn.onEvent(msg); } catch (e) {} }
        }
      }
    });

    sock.on('connect', function () {
      sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });

    conn.send = function (method, params) {
      return new Promise(function (res, rej) {
        if (conn.closed) return rej(new Error('ws closed'));
        const mid = ++conn.id;
        conn.pend.set(mid, function (m) { m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result); });
        connSend(conn, Buffer.from(JSON.stringify({ id: mid, method: method, params: params || {} }), 'utf8'), 0x1);
      });
    };
    conn.close = function () { try { sock.end(); } catch (e) {} };
  });
}
function connSend(conn, payload, opcode) {
  if (conn.closed) return;
  const len = payload.length;
  let header;
  // 客户端 -> 服务端必须带 MASK 位(0x80)，否则 Chrome 判定协议错误直接断开
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  // 客户端 -> 服务端必须掩码
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  const out = Buffer.concat([header, mask, masked]);
  try { conn.sock.write(out); } catch (e) {}
}

/* ---------------- Chrome 进程管理 ---------------- */
function httpJson(url, method) {
  return new Promise(function (resolve, reject) {
    const req = http.request(url, { method: method || 'GET', timeout: 5000 }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.end();
  });
}
function killChrome() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} proc = null; chrome = null; }
}
async function ensureBrowser() {
  if (proc) return;
  const exe = findChrome();
  dbg('chrome exe = ' + exe);
  if (!exe) throw new Error('未找到 Chrome/Edge，无法取数');
  const ud = path.join(os.tmpdir(), 'yt-voyage-profile');
  proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud,
    HOME_URL
  ], { stdio: 'ignore', windowsHide: true });
  proc.on('exit', function () { proc = null; chrome = null; });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const v = await httpJson('http://127.0.0.1:' + PORT + '/json/version');
      if (v && v.webSocketDebuggerUrl) { dbg('browser ready, port ' + PORT); return; }
    } catch (e) {}
  }
  killChrome();
  throw new Error('浏览器启动超时');
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      const p = (list || []).find(function (t) { return t.type === 'page' && t.url && t.url.indexOf('156yt.cn') >= 0; });
      if (p && p.webSocketDebuggerUrl) { dbg('target(156yt) ' + p.url); return p; }
      const any = (list || []).find(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; });
      if (any) { dbg('target(any) ' + any.url); return any; }
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('取不到页面目标');
}

/* ---------------- 取数主流程 ---------------- */
async function doQuery(opt) {
  const date = opt.date || today();
  const ship = opt.ship || '';
  const voy = opt.voy || '';
  if (!ship && !voy) throw new Error('船名和码头航次至少要填一个');

  await ensureBrowser();
  const target = await getPageTarget();
  const conn = await wsConnect(target.webSocketDebuggerUrl);
  try {
    conn.onEvent = function (m) {                       // 关掉可能的原生 alert
      if (m.method === 'Page.javascriptDialogOpening') {
        try { conn.send('Page.handleJavaScriptDialog', { accept: true }); } catch (e) {}
      }
    };
    const ev = async function (expr) {
      try {
        const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) return null;            // 导航中上下文已销毁，交给外层重试
        return r.result.value;
      } catch (e) { return null; }
    };
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    dbg('cdp connected');

    const waitTitle = async function (kw, max) {
      for (let i = 0; i < (max || 40); i++) {
        await sleep(700);
        const t = await ev('document.title');
        if (DEBUG && i % 5 === 0) dbg('waitTitle ' + kw + ' -> ' + t);
        if (t && String(t).indexOf(kw) >= 0) return true;
      }
      dbg('waitTitle TIMEOUT ' + kw);
      return false;
    };
    const waitText = async function (kw, max) {
      for (let i = 0; i < (max || 40); i++) {
        await sleep(700);
        const t = await ev("(document.body.innerText||'').indexOf('" + kw + "')>=0");
        if (t === true) return true;
      }
      dbg('waitText TIMEOUT ' + kw);
      return false;
    };

    // 1) 若当前不是船期页，先回首页建会话，再从站内点进去（直接进会被弹回首页）
    let title = await ev('document.title');
    dbg('current title = ' + title);
    if (!title || String(title).indexOf('船期') < 0) {
      await conn.send('Page.navigate', { url: HOME_URL });
      await waitTitle('公共信息');
      await ev("(function(){var a=null;document.querySelectorAll('a').forEach(function(x){if((x.getAttribute('href')||'').indexOf('voyQuery.jsp')>=0)a=x;});if(a){a.setAttribute('target','_self');location.href=a.getAttribute('href');}return 1;})()");
      const ok = await waitTitle('船期');
      dbg('entered form page = ' + ok + ' title=' + (await ev('document.title')));
    }

    // 2) 填表 + 点击查询（用 .click()，不用 form.submit()）
    const filled = await ev("(function(){" +
      "var f=document.forms['form1']||document.querySelector('form');if(!f)return 0;" +
      "if(f.elements['etb_time'])f.elements['etb_time'].value=" + JSON.stringify(date) + ";" +
      "if(f.elements['ship_name'])f.elements['ship_name'].value=" + JSON.stringify(ship) + ";" +
      "if(f.elements['voyage_code'])f.elements['voyage_code'].value=" + JSON.stringify(voy) + ";" +
      "var b=document.querySelector(\"input[name='Submit1']\");if(!b)return 0;b.click();return 1;})()");
    if (!filled) throw new Error('页面结构变了，找不到查询表单');

    // 3) 等结果
    if (!await waitText('总记录数', 45)) throw new Error('查询结果超时');

    const raw = await ev("(function(){" +
      "var o={rows:[],total:0,page:1,pages:1};" +
      "var t=document.body.innerText||'';" +
      "var m=t.match(/总记录数：\\s*(\\d+)[\\s\\S]{0,40}?当前页：\\s*(\\d+)[\\s\\S]{0,40}?总页数：\\s*(\\d+)/);" +
      "if(m){o.total=+m[1];o.page=+m[2];o.pages=+m[3];}" +
      "var tb=null;document.querySelectorAll('table').forEach(function(x){if(x.rows.length>1&&(x.rows[0].textContent||'').indexOf('船名')>=0)tb=x;});" +
      "if(tb){for(var i=1;i<tb.rows.length;i++){var c=[];tb.rows[i].querySelectorAll('td').forEach(function(td){c.push((td.textContent||'').replace(/\\s+/g,' ').trim());});if(c.length>=6)o.rows.push(c);}}" +
      "return JSON.stringify(o);})()");
    if (!raw) throw new Error('读不到结果表格');
    const o = JSON.parse(raw);
    return {
      ok: true,
      query: { ship: ship, voy: voy, date: date },
      total: o.total, page: o.page, pages: o.pages,
      rows: o.rows.map(function (c) {
        return { voyage: c[0], ship: c[1], gate: c[2], etb: c[3], etd: c[4], agent: c[5] };
      })
    };
  } finally {
    try { conn.close(); } catch (e) {}
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(killChrome, IDLE_KILL_MS);
  }
}

const queue = [];
function query(opt) {
  return new Promise(function (resolve, reject) {
    queue.push({ opt: opt, resolve: resolve, reject: reject });
    if (!busy) runQueue();
  });
}
async function runQueue() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  let timer = null;
  try {
    const t = new Promise(function (_, rej) { timer = setTimeout(function () { killChrome(); rej(new Error('取数超时（90s）')); }, 90000); });
    const r = await Promise.race([doQuery(job.opt), t]);
    clearTimeout(timer);
    job.resolve(r);
  } catch (e) {
    if (timer) clearTimeout(timer);
    job.reject(e);
  }
  busy = false;
  if (queue.length) runQueue();
}
function today() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

module.exports = { query: query, kill: killChrome, today: today, FORM_ACTION: FORM_ACTION, _ws: wsConnect, _port: function () { return PORT; } };

/* ---------------- CLI ---------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = function (k, d) { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const ship = get('ship', '');
  const voy = get('voy', '');
  const date = get('date', today());
  if (!ship && !voy) {
    console.log('用法: node yt-voyage.js --ship "YM WORTHINESS" [--date 20261023] [--voy 003W]');
    process.exit(1);
  }
  query({ ship: ship, voy: voy, date: date }).then(function (r) {
    console.log('查询条件: 船名=' + (ship || '-') + ' 航次=' + (voy || '-') + ' 起始日期=' + date);
    console.log('总记录数: ' + r.total + '  第 ' + r.page + '/' + r.pages + ' 页  本页 ' + r.rows.length + ' 条');
    console.log('--------------------------------------------------------------');
    console.log('码头航次 | 船名 | 闸口 | ETB | ETD | 船代');
    r.rows.forEach(function (x) {
      console.log([x.voyage, x.ship, x.gate, x.etb, x.etd, x.agent].join(' | '));
    });
    if (get('json', '') === '1') console.log(JSON.stringify(r, null, 1));
    killChrome();
    process.exit(0);
  }).catch(function (e) {
    console.log('取数失败: ' + e.message);
    killChrome();
    process.exit(1);
  });
}
