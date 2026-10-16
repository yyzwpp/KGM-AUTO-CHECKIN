/* kgcheckin webui 前端逻辑（无框架，原生 JS） */
/* eslint-env browser */
'use strict'

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))

/* ────────────────── 基础工具 ────────────────── */

let AUTH = sessionStorage.getItem('kc_auth') || ''
if (AUTH) $('#auth-state').textContent = '已解锁'

let authResolvers = []

function askAuth() {
  return new Promise(resolve => {
    authResolvers.push(resolve)
    $('#auth-err').textContent = ''
    $('#auth-input').value = AUTH
    if (!$('#auth-dialog').open) $('#auth-dialog').showModal()
  })
}

function resolveAuth(ok) {
  $('#auth-dialog').close()
  authResolvers.forEach(r => r(ok))
  authResolvers = []
}

$('#btn-auth-ok').addEventListener('click', submitAuth)
$('#auth-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth() })

async function submitAuth() {
  AUTH = $('#auth-input').value.trim()
  try {
    await api('/api/status')
    sessionStorage.setItem('kc_auth', AUTH)
    $('#auth-state').textContent = '已解锁'
    $('#auth-err').textContent = ''
    resolveAuth(true)
    refreshAll()
  } catch (e) {
    $('#auth-err').textContent = `// 密码错误：${e.message}`
  }
}

let ACCOUNTS_KEY = sessionStorage.getItem('kc_accts') || ''
let ACCOUNTS_ID = sessionStorage.getItem('kc_accts_id') || ''

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (AUTH) headers['X-WebUI-Key'] = AUTH
  if (ACCOUNTS_KEY) headers['X-Accounts-Key'] = ACCOUNTS_KEY
  if (ACCOUNTS_ID) headers['X-Accounts-Id'] = ACCOUNTS_ID
  const res = await fetch(path, { ...opts, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 全局访问密码未通过：弹窗后重试。
    // 账号管理模块的 401（code=accounts-auth）不走这里，由对应面板自行展示锁屏/倒计时
    if (res.status === 401 && data.code === 'webui-auth') {
      const granted = await askAuth()
      if (granted) return api(path, opts)
    }
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

let toastTimer = null
function toast(msg, type = '') {
  const el = $('#toast')
  el.textContent = msg
  el.className = `toast show ${type}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = 'toast' }, 4000)
}

/* ────────────────── 标签页 ────────────────── */

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab))
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`))
    if (tab.dataset.tab === 'accounts') loadAccounts()
  })
})

/* ────────────────── 状态徽章 / 账号列表 ────────────────── */

function setChip(id, text, cls) {
  const el = $(id)
  el.textContent = text
  el.className = `chip ${cls || ''}`
}

let lastStatus = null

async function refreshStatus() {
  let s
  try {
    s = await api('/api/status')
  } catch (e) {
    setChip('#chip-cred', `▮ 服务: ${e.message}`, 'err')
    return
  }
  lastStatus = s

  const n = s.accountCount
  setChip('#chip-cred', `▮ 凭据: ${n > 0 ? `${n} 个账号` : '未配置'}`, n > 0 ? 'ok' : 'warn')

  const sched = s.schedule
  setChip(
    '#chip-cron',
    sched.valid ? `▮ 计划: ${sched.cron} → ${sched.nextRuns[0] || '--'}` : '▮ 计划: 无效',
    sched.valid ? 'info' : 'err'
  )
  $('#cron-tip').textContent = sched.valid
    ? (sched.previewSupported === false
        ? `⏰ 定时签到：${sched.cron}（${sched.timezone}）· 该表达式不支持预览执行时间`
        : `⏰ 定时签到：${sched.cron}（${sched.timezone}），接下来执行：${sched.nextRuns.join(' / ') || '-'}`)
    : '⚠ CRON_SCHEDULE 无效，定时签到未启用，只能手动签到'

  setChip('#chip-run', `▮ 签到: ${s.checkin.running ? '运行中' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? '上次成功' : '上次失败') : '从未运行'}`,
    s.checkin.running ? 'warn' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? 'ok' : 'err') : '')
  $('#btn-run').disabled = s.checkin.running
  $('#run-state').textContent = s.checkin.running
    ? '// 签到任务运行中…'
    : s.checkin.lastRun
      ? `// 上次运行：${s.checkin.lastRun.trigger === 'cron' ? '定时' : s.checkin.lastRun.trigger === 'startup' ? '启动' : '手动'} · 退出码 ${s.checkin.lastRun.exitCode}`
      : '// 空闲'
}

/* ────────────────── 账号管理（独立密码锁）────────────────── */

let accountsTimer = null

function showAccountsLock(msg, isErr) {
  $('#accounts-lock').hidden = false
  $('#accounts-content').hidden = true
  const el = $('#accounts-lock-msg')
  el.textContent = msg || ''
  el.className = isErr ? 'err' : 'dim'
}

function renderAccounts(accounts, admin, mustChangePassword) {
  const box = $('#account-list')
  $('#accounts-lock').hidden = true
  $('#accounts-content').hidden = false
  $('#accounts-who').textContent = admin ? '// 当前身份：admin（管理员）' : `// 当前身份：${ACCOUNTS_ID}`
  $('#btn-accounts-passwd').hidden = false
  // 以默认密码（酷狗ID）登录：提示尽快修改，避免他人凭 ID 登录并改密
  const warn = $('#accounts-default-pwd-warn')
  if (warn) {
    warn.hidden = !mustChangePassword
    warn.textContent = mustChangePassword
      ? '⚠ 当前使用的是默认密码（酷狗ID）。酷狗ID 对他人可见，请立即点击「修改密码」设置自己的密码。'
      : ''
  }
  if (!accounts.length) {
    box.innerHTML = '<div class="empty dim">// 暂无账号，请先在「扫码登录」或「手机号登录」中添加</div>'
    return
  }
  box.innerHTML = ''
  accounts.forEach(acct => {
    const div = document.createElement('div')
    div.className = 'account-item'
    // 昵称（完整，后端已按面板授权返回）显示在 userid 左侧；无昵称时保持原布局
    const nameHtml = acct.nickname
      ? `<span class="acct-name">${escapeHtml(acct.nickname)}</span><span class="acct-sep">·</span>`
      : ''
    const noPwdHint = acct.hasPassword
      ? ''
      : '<div class="acct-sub warn">⚠ 仍在使用默认密码（酷狗ID），建议尽快修改</div>'
    div.innerHTML = `
      <div class="acct-main">
        <div class="acct-id"><span class="idx">[${acct.index}]</span>${nameHtml}userid: ${acct.userid}</div>
        <div class="acct-sub">token: ****（${acct.tokenLength} 字符）· 每周日签到时自动刷新</div>
        ${noPwdHint}
      </div>`
    const btn = document.createElement('button')
    btn.className = 'btn danger-ghost'
    btn.textContent = '[ 删除 ]'
    btn.addEventListener('click', async () => {
      if (!confirm(`确认删除账号 ${acct.userid}？`)) return
      try {
        // 按 userid 删除：避免列表在操作期间变化导致误删他人账号
        await api(`/api/accounts/by-id/${encodeURIComponent(acct.rawUserid)}`, { method: 'DELETE' })
        toast('账号已删除', 'ok')
        loadAccounts()
        refreshStatus()
      } catch (e) {
        if (e.status === 423) lockdownAccounts(e.data && e.data.retryAfter, e.message)
        else toast(e.message, 'err')
      }
    })
    div.appendChild(btn)
    box.appendChild(div)
  })
}

/** 锁定倒计时：禁用输入与按钮，结束自动恢复 */
function lockdownAccounts(seconds, msg) {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  showAccountsLock(msg || '', true)
  idInput.disabled = true
  input.disabled = true
  btn.disabled = true
  clearInterval(accountsTimer)
  let remain = Math.max(1, parseInt(seconds, 10) || 300)
  const tick = () => {
    if (remain <= 0) {
      clearInterval(accountsTimer)
      idInput.disabled = false
      input.disabled = false
      btn.disabled = false
      $('#accounts-lock-msg').textContent = '// 锁定已解除，请输入密码'
      $('#accounts-lock-msg').className = 'dim'
      return
    }
    const mm = String(Math.floor(remain / 60)).padStart(2, '0')
    const ss = String(remain % 60).padStart(2, '0')
    $('#accounts-lock-msg').textContent = `⏳ ${msg ? msg + ' · ' : ''}剩余 ${mm}:${ss}`
    remain--
  }
  tick()
  accountsTimer = setInterval(tick, 1000)
}

async function loadAccounts() {
  clearInterval(accountsTimer)
  try {
    const r = await api('/api/accounts')
    renderAccounts(r.accounts, r.admin, r.mustChangePassword)
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    // 401：需要输入凭据（未提供凭据不计失败次数）
    showAccountsLock(e.status === 401 ? '' : `// 加载失败：${e.message}`, e.status !== 401)
  }
}

async function tryUnlock() {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  if (input.disabled) return
  const id = idInput.value.trim()
  const pwd = input.value.trim()
  if (!id || !pwd) {
    showAccountsLock('// 请输入酷狗ID和密码', true)
    return
  }
  btn.disabled = true
  try {
    const r = await api('/api/accounts/unlock', { method: 'POST', body: JSON.stringify({ userid: id, password: pwd }) })
    ACCOUNTS_ID = id
    ACCOUNTS_KEY = pwd
    sessionStorage.setItem('kc_accts_id', id)
    sessionStorage.setItem('kc_accts', pwd)
    input.value = ''
    await loadAccounts()
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    showAccountsLock(`// ${e.message}`, true)
    btn.disabled = false
  }
}

$('#btn-accounts-unlock').addEventListener('click', tryUnlock)
$('#accounts-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })
$('#accounts-id').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })

$('#btn-accounts-lock').addEventListener('click', () => {
  ACCOUNTS_KEY = ''
  ACCOUNTS_ID = ''
  sessionStorage.removeItem('kc_accts')
  sessionStorage.removeItem('kc_accts_id')
  showAccountsLock('')
})

/* ── 修改密码 ── */
$('#btn-accounts-passwd').addEventListener('click', async () => {
  const isAdmin = ACCOUNTS_ID === 'admin'
  const targetUserid = isAdmin
    ? prompt('输入要修改密码的账号酷狗ID（留空取消）：')
    : ACCOUNTS_ID
  if (!targetUserid) return
  const newPassword = prompt(`为账号 ${targetUserid} 设置新密码（4-64 位）：`)
  if (newPassword == null) return
  if (newPassword.length < 4 || newPassword.length > 64) {
    toast('新密码长度需为 4-64 位', 'err')
    return
  }
  try {
    await api('/api/accounts/password', {
      method: 'POST',
      body: JSON.stringify({ newPassword, ...(isAdmin ? { targetUserid } : {}) }),
    })
    toast('密码已更新', 'ok')
    // 若修改的是自己的密码，更新本地凭据
    if (!isAdmin) {
      ACCOUNTS_KEY = newPassword
      sessionStorage.setItem('kc_accts', newPassword)
    }
  } catch (e) {
    toast(e.message, 'err')
  }
})

/* ────────────────── 扫码登录 ────────────────── */

let qrPolling = false
let qrKeys = [] // { key, card, done }

$('#btn-qr-gen').addEventListener('click', async () => {
  const btn = $('#btn-qr-gen')
  const number = parseInt($('#qr-count').value, 10) || 1
  btn.disabled = true
  $('#qr-hint').textContent = '// 正在生成…'
  try {
    const { items } = await api('/api/qr/gen', { method: 'POST', body: JSON.stringify({ number }) })
    const list = $('#qr-list')
    list.innerHTML = ''
    qrKeys = items.map((item, i) => {
      const card = document.createElement('div')
      card.className = 'qr-card'
      card.innerHTML = `
        <h3>账号 ${i + 1}/${items.length} <span class="dim">· 请用酷狗音乐 APP 扫码</span></h3>
        <div class="qr-img-wrap"><img alt="登录二维码" src="${item.dataUrl}" /></div>
        <div class="qr-status wait">⏳ 等待扫描…</div>`
      list.appendChild(card)
      return { key: item.key, card, done: false }
    })
    $('#qr-hint').textContent = `// 已生成 ${items.length} 个二维码，等待扫码确认（约 2 分钟有效）`
    startQrPolling()
    toast('二维码已生成，请扫码', 'ok')
  } catch (e) {
    $('#qr-hint').textContent = ''
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
  }
})

function startQrPolling() {
  if (qrPolling) return
  qrPolling = true
  const timer = setInterval(async () => {
    const pending = qrKeys.filter(k => !k.done)
    if (!pending.length) {
      clearInterval(timer)
      qrPolling = false
      return
    }
    await Promise.all(pending.map(async item => {
      try {
        const r = await api(`/api/qr/status?qrcode=${encodeURIComponent(item.key)}`)
        const statusEl = item.card.querySelector('.qr-status')
        if (r.status === 1) {
          statusEl.textContent = '⏳ 等待扫描…'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 2) {
          statusEl.textContent = '👀 已扫描，请在手机上确认登录'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 4) {
          item.done = true
          item.card.classList.add('done')
          statusEl.textContent = `✓ 登录成功 · 账号 ${r.userid}${r.saved ? ' 已保存' : ''}`
          statusEl.className = 'qr-status ok'
          toast(`账号 ${r.userid} 登录成功`, 'ok')
          refreshStatus()
        } else {
          item.done = true
          statusEl.textContent = r.status === 0 ? '✗ 二维码已过期，请重新生成' : `✗ 异常状态（${r.status}），请重新生成`
          statusEl.className = 'qr-status err'
        }
      } catch (e) {
        const statusEl = item.card.querySelector('.qr-status')
        statusEl.textContent = `✗ ${e.message}`
        statusEl.className = 'qr-status err'
        item.done = true
      }
    }))
  }, 3000)
}

/* ────────────────── 手机号登录 ────────────────── */

$('#btn-send-code').addEventListener('click', async () => {
  const btn = $('#btn-send-code')
  const phone = $('#phone').value.trim()
  if (!/^1[3-9]\d{9}$/.test(phone)) { toast('手机号格式不正确', 'err'); return }
  btn.disabled = true
  try {
    await api('/api/phone/send', { method: 'POST', body: JSON.stringify({ phone }) })
    toast('验证码已发送，请查收短信', 'ok')
    let left = 60
    btn.textContent = `[ 重新发送(${left}s) ]`
    const timer = setInterval(() => {
      left--
      if (left <= 0) { clearInterval(timer); btn.textContent = '[ 发送验证码 ]'; btn.disabled = false }
      else btn.textContent = `[ 重新发送(${left}s) ]`
    }, 1000)
  } catch (e) {
    btn.disabled = false
    toast(e.message, 'err')
  }
})

$('#btn-phone-login').addEventListener('click', async () => {
  const btn = $('#btn-phone-login')
  const phone = $('#phone').value.trim()
  const code = $('#code').value.trim()
  btn.disabled = true
  $('#phone-hint').textContent = '// 登录中…'
  try {
    const r = await api('/api/phone/login', { method: 'POST', body: JSON.stringify({ phone, code }) })
    $('#phone-hint').textContent = `// ✓ 登录成功，账号 ${r.userid} 已保存`
    $('#code').value = ''
    toast(`账号 ${r.userid} 登录成功`, 'ok')
    refreshStatus()
  } catch (e) {
    $('#phone-hint').textContent = `// ${e.message}`
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
  }
})

/* ────────────────── 一键签到 + 实时日志 ────────────────── */

const ANSI_RE = /\x1B\[([0-9;]*)m/g
const ANSI_CLASS = {
  1: 'bold', 2: 'c-dim',
  30: 'c-dim', 31: 'c-red', 32: 'c-green', 33: 'c-yellow', 34: 'c-blue', 35: 'c-magenta', 36: 'c-blue', 37: 'c-dim',
  90: 'c-dim', 91: 'c-red', 92: 'c-green', 93: 'c-yellow', 94: 'c-blue', 95: 'c-magenta',
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把含 ANSI 转义的日志行转换为带颜色的 HTML（colorOut 输出形如 \x1B[31m…\x1B[0m） */
function ansiToHtml(raw) {
  let html = ''
  let classes = []
  let last = 0
  ANSI_RE.lastIndex = 0
  let m
  while ((m = ANSI_RE.exec(raw)) !== null) {
    html += escapeHtml(raw.slice(last, m.index))
    last = ANSI_RE.lastIndex
    const codes = (m[1] || '0').split(';').map(c => parseInt(c, 10) || 0)
    classes = codes.includes(0) ? [] : codes.map(c => ANSI_CLASS[c]).filter(Boolean)
  }
  html += escapeHtml(raw.slice(last))
  return classes.length ? `<span class="${classes.join(' ')}">${html}</span>` : html
}

function appendLog(entry) {
  const body = $('#term-body')
  const line = document.createElement('div')
  const ts = entry.ts ? `<span class="ts">${entry.ts.slice(11, 19)}</span> ` : ''
  line.className = `line ${entry.level === 'log' ? '' : entry.level}`
  line.innerHTML = ts + ansiToHtml(entry.text)
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60
  const placeholder = body.querySelector('.dim')
  if (placeholder && placeholder.textContent.includes('等待任务输出')) placeholder.remove()
  body.appendChild(line)
  // 限制 DOM 行数
  while (body.children.length > 800) body.removeChild(body.firstChild)
  if (nearBottom) body.scrollTop = body.scrollHeight
}

function clearTerm() {
  $('#term-body').innerHTML = ''
}

$('#btn-clear-log').addEventListener('click', clearTerm)

let sse = null

function connectSse() {
  if (sse) return
  const url = AUTH ? `/api/checkin/logs?key=${encodeURIComponent(AUTH)}` : '/api/checkin/logs'
  sse = new EventSource(url)
  sse.addEventListener('hello', ev => {
    const info = JSON.parse(ev.data)
    if (info.lastRun) $('#run-state').textContent = `// 上次运行：退出码 ${info.lastRun.exitCode ?? '-'}`
  })
  sse.onmessage = ev => appendLog(JSON.parse(ev.data))
  sse.addEventListener('start', () => { $('#run-state').textContent = '// 签到任务运行中…' })
  sse.addEventListener('end', ev => {
    const r = JSON.parse(ev.data)
    $('#run-state').textContent = r.ok ? '// ✓ 签到完成' : `// ✗ 签到结束，退出码 ${r.exitCode}`
    toast(r.ok ? '签到任务执行成功' : `签到任务失败（退出码 ${r.exitCode}）`, r.ok ? 'ok' : 'err')
    refreshStatus()
  })
  sse.onerror = () => {
    // 401 等致命错误会让连接进入 CLOSED；置空以便输入密码后能带密钥重建连接
    // （普通网络抖动时 readyState 为 CONNECTING，EventSource 会自动重连，无需处理）
    if (sse && sse.readyState === EventSource.CLOSED) sse = null
  }
}

$('#btn-run').addEventListener('click', async () => {
  const btn = $('#btn-run')
  btn.disabled = true
  try {
    await api('/api/checkin/run', { method: 'POST', body: '{}' })
    $('#run-state').textContent = '// 签到任务已启动…'
    toast('签到任务已启动', 'ok')
    refreshStatus()
  } catch (e) {
    btn.disabled = false
    toast(e.message, 'err')
    refreshStatus()
  }
})

/* ────────────────── 启动 ────────────────── */

function refreshAll() {
  refreshStatus()
  connectSse()
}

refreshAll()
setInterval(refreshStatus, 5000)

// 支持 #qr / #phone / #run / #accounts 直达对应标签页
const initialTab = location.hash.replace('#', '')
const initialTabEl = $$('.tab').find(t => t.dataset.tab === initialTab)
if (initialTabEl) initialTabEl.click()
