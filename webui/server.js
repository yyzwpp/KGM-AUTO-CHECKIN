/**
 * kgcheckin WebUI 服务。
 *
 * 容器内一体化运行：
 *   - Web 控制台（扫码登录 / 手机号登录 / 一键签到 / 账号管理）
 *   - 内置定时调度（node-cron，替代独立 scheduler 进程）
 *   - 常驻酷狗 API 服务子进程（端口 WEBUI_API_PORT，懒启动 + 空闲自动关闭）供登录类操作使用
 *   - 签到任务以子进程运行 main.js，其 API 服务使用独立端口 CHECKIN_API_PORT，与登录服务互不冲突
 *
 * 环境变量：
 *   WEBUI_PORT        Web 控制台监听端口（默认 3000）
 *   WEBUI_PASSWORD    可选访问密码；设置后所有 /api/* 需携带 X-WebUI-Key 头（或 ?key= 查询参数，供 SSE 使用）
 *   WEBUI_TRUST_PROXY 反向代理部署时设置（如 "1"）：信任 X-Forwarded-For 以取真实 IP。
 *                     未设置时不信任该头，避免伪造 IP 绕过按 IP 的防爆破计数。
 *   ACCOUNTS_PASSWORD admin 管理员密码；设置后 admin 可查看/管理所有账号（未设置则 admin 不可用）
 *   ACCOUNTS_BOOTSTRAP_PASSWORD 首次启动（尚无 accounts_auth.json）时用它初始化 admin 密码
 *   ACCOUNTS_DISABLE_ID_DEFAULT 设为 true 时关闭「未设密码账号可用酷狗ID 登录」（默认允许，便于首次改密）。
 *                     酷狗ID 并非秘密，公网暴露时建议设 true 并让 admin 预先分发密码。
 *   ACCOUNTS_MAX_ATTEMPTS 单账号连续错误锁定阈值（默认 3）
 *   ACCOUNTS_IP_MAX_ATTEMPTS 单 IP 连续错误锁定阈值（默认 ACCOUNTS_MAX_ATTEMPTS × 5）
 *   ACCOUNTS_LOCK_MINUTES 锁定时长（默认 5 分钟）
 *   WEBUI_API_PORT    登录用 API 服务端口（默认 3010）
 *   CHECKIN_API_PORT  签到子进程 API 服务端口（默认 3020）
 *   CRON_SCHEDULE     签到计划任务（默认 "10 1 * * *"，每天北京时间 01:10）
 *   CRON_TIMEZONE     调度时区（默认 Asia/Shanghai）
 *   RUN_ON_STARTUP    "true" 时容器启动后立即执行一次签到
 *   USERINFO_FILE     凭据文件路径（Docker 镜像默认 /app/data/userinfo.json）
 */

import express from 'express'
import cron from 'node-cron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { close_api, delay, send, startService, waitForApi } from '../utils/utils.js'
import { upsertUser, writeUserinfoFile, parseUserinfoJson } from '../utils/userinfo.js'
import { maskIdentifier, summarizeResponse } from '../utils/safeLog.js'
import { printGreen, printMagenta, printRed, printYellow } from '../utils/colorOut.js'
import { nextCronRuns } from '../utils/date.js'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ────────────────────────── 配置 ──────────────────────────

const WEBUI_PORT = Number(process.env.WEBUI_PORT || 3000)
const WEBUI_PASSWORD = String(process.env.WEBUI_PASSWORD || '').trim()
// 仅当显式配置时才信任 X-Forwarded-For（反向代理部署）。默认关闭：
// 无条件信任会让攻击者伪造 XFF 头绕过按 IP 的防爆破计数。
const WEBUI_TRUST_PROXY = process.env.WEBUI_TRUST_PROXY
const ACCOUNTS_PASSWORD = String(process.env.ACCOUNTS_PASSWORD || '').trim()
const ACCOUNTS_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.ACCOUNTS_MAX_ATTEMPTS || '3', 10))
const ACCOUNTS_LOCK_MINUTES = Math.max(0.01, parseFloat(process.env.ACCOUNTS_LOCK_MINUTES || '5'))
const ACCOUNTS_LOCK_MS = ACCOUNTS_LOCK_MINUTES * 60 * 1000
// per-IP 阈值放宽（同 NAT 下多个用户不应互相拖累）；per-账号桶仍用 ACCOUNTS_MAX_ATTEMPTS
const ACCOUNTS_IP_MAX_ATTEMPTS = Math.max(
  ACCOUNTS_MAX_ATTEMPTS,
  parseInt(process.env.ACCOUNTS_IP_MAX_ATTEMPTS || String(ACCOUNTS_MAX_ATTEMPTS * 5), 10) || ACCOUNTS_MAX_ATTEMPTS * 5
)
// 未设置密码的账号是否允许以「酷狗ID 作为默认密码」登录（默认允许，便于用户首次改密）。
// 设为 true 可关闭该行为，此时未设密码的账号必须由 admin 先设置密码。
// ⚠ 酷狗ID 并非秘密，开启默认密码意味着知道 ID 的人即可登录并改密，公网部署请谨慎。
const ACCOUNTS_DISABLE_ID_DEFAULT = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.ACCOUNTS_DISABLE_ID_DEFAULT || '').trim().toLowerCase()
)
// 首次启动用于初始化 admin 的引导密码（accounts_auth.json 不存在时使用）
const ACCOUNTS_BOOTSTRAP_PASSWORD = String(process.env.ACCOUNTS_BOOTSTRAP_PASSWORD || '').trim()
const WEBUI_API_PORT = process.env.WEBUI_API_PORT || '3010'
const CHECKIN_API_PORT = process.env.CHECKIN_API_PORT || '3020'
const SCHEDULE = process.env.CRON_SCHEDULE || '10 1 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Shanghai'
const RUN_ON_STARTUP = ['1', 'true', 'yes', 'on'].includes(String(process.env.RUN_ON_STARTUP || '').toLowerCase())
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000

// 本进程内 utils（startService/send/waitForApi）统一使用登录专用端口
process.env.API_PORT = WEBUI_API_PORT
if (!process.env.USERINFO_FILE) {
  process.env.USERINFO_FILE = path.join(ROOT, 'data', 'userinfo.json')
}
const USERINFO_FILE = process.env.USERINFO_FILE

const BOOT_AT = new Date().toISOString()

// ────────────────────────── 凭据文件 ──────────────────────────

function readUserinfo() {
  try {
    // parseUserinfoJson 兼容 UTF-8 BOM（Windows 记事本保存的文件）
    return parseUserinfoJson(fs.readFileSync(USERINFO_FILE, 'utf8')) || []
  } catch {
    return []
  }
}

function readUserinfoRaw() {
  try {
    // 去除 BOM 后作为整体文本传给签到子进程（main.js 侧亦有兜底解析）
    return fs.readFileSync(USERINFO_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

function saveUserinfo(arr) {
  return writeUserinfoFile(JSON.stringify(arr))
}

// ────────────────────────── 登录用 API 服务管理 ──────────────────────────
// 懒启动 + 引用计数 + 空闲超时自动关闭；登录操作按请求短暂持有。

const loginApi = {
  child: null,
  refCount: 0,
  idleTimer: null,
  starting: null,

  async acquire() {
    if (this.starting) await this.starting
    if (!this.child) {
      this.starting = (async () => {
        printYellow(`[webui] 启动本地 API 服务 (port ${WEBUI_API_PORT})...`)
        const child = startService()
        try {
          await waitForApi(undefined, 30000)
        } catch (e) {
          close_api(child)
          throw e
        }
        this.child = child
        printGreen('[webui] 本地 API 服务已就绪')
      })()
      try {
        await this.starting
      } finally {
        this.starting = null
      }
    }
    this.refCount++
    clearTimeout(this.idleTimer)
  },

  release() {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount === 0) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS)
    }
  },

  shutdown() {
    if (!this.child) return
    close_api(this.child)
    this.child = null
    printYellow('[webui] 本地 API 服务空闲，已关闭')
  },

  running() {
    return Boolean(this.child)
  },
}

/** 在持有 API 服务期间执行 fn（自动获取/释放） */
async function withApi(fn) {
  await loginApi.acquire()
  try {
    return await fn()
  } finally {
    loginApi.release()
  }
}

// ────────────────────────── 签到任务 ──────────────────────────

const LOG_BUFFER_MAX = 800
const checkinState = {
  running: false,
  lastRun: null, // { startedAt, endedAt, exitCode, ok, trigger }
  logs: [],      // 环形缓冲 { ts, level, text }，text 含原始 ANSI 转义
  sseClients: new Set(),
}

function pushLog(level, text) {
  const entry = { ts: new Date().toISOString(), level, text }
  checkinState.logs.push(entry)
  if (checkinState.logs.length > LOG_BUFFER_MAX) {
    checkinState.logs.splice(0, checkinState.logs.length - LOG_BUFFER_MAX)
  }
  // 同步镜像到容器 stdout，保证 docker compose logs 也能看到签到明细
  console.log(`[checkin] ${text}`)
  const payload = `data: ${JSON.stringify(entry)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* 断开的连接在 close 时清理 */ }
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* ignore */ }
  }
}

/**
 * 启动一次签到子进程（node main.js）。
 * 子进程通过 API_PORT 使用独立端口拉起自己的 API 服务，与登录服务互不冲突；
 * 凭据优先取挂载卷文件内容，其次继承环境变量 USERINFO。
 */
function startCheckin(trigger = 'manual') {
  if (checkinState.running) return false

  checkinState.running = true
  const startedAt = new Date().toISOString()
  checkinState.lastRun = { startedAt, trigger, running: true }

  pushLog('sys', `────── 签到任务开始（${trigger === 'cron' ? '定时调度' : trigger === 'startup' ? '启动触发' : '手动触发'} · ${startedAt}）──────`)
  broadcast('start', checkinState.lastRun)

  const userinfoRaw = readUserinfoRaw()

  // 凭据通过 stdin 传给子进程，而不是放进环境变量：
  // 环境变量可被同容器/同主机的其他进程经 /proc/<pid>/environ 读取，等于把 token 暴露给任意进程。
  const env = { ...process.env, API_PORT: CHECKIN_API_PORT }
  delete env.USERINFO           // 防止父进程环境变量里的旧凭据泄漏给子进程
  if (userinfoRaw) env.USERINFO_STDIN = '1'
  // 手动触发时跳过当日已完成签到的账号（定时/启动触发不设置，保持完整执行）
  if (trigger === 'manual') {
    env.CHECKIN_SKIP_DONE = '1'
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'main.js')], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 写入凭据后立即关闭 stdin，供子进程读取
  if (userinfoRaw) {
    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ })
    child.stdin.end(userinfoRaw, 'utf8')
  } else {
    child.stdin.end()
  }

  const onStream = buf => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) pushLog('log', line)
    }
  }
  child.stdout.on('data', onStream)
  child.stderr.on('data', onStream)

  child.on('error', err => {
    pushLog('err', `签到进程启动失败：${err.message}`)
  })

  child.on('exit', code => {
    const exitCode = code ?? 1
    checkinState.running = false
    checkinState.lastRun = {
      ...checkinState.lastRun,
      endedAt: new Date().toISOString(),
      exitCode,
      ok: exitCode === 0,
      running: false,
    }
    pushLog(exitCode === 0 ? 'ok' : 'err', `────── 签到任务结束（退出码 ${exitCode}）──────`)
    broadcast('end', checkinState.lastRun)
  })

  return true
}

// ────────────────────────── 计划预览 ──────────────────────────

/** 预览 cron 接下来 n 次执行时间（按 CRON_TIMEZONE 时区计算） */
function nextRuns(n = 3) {
  return nextCronRuns(SCHEDULE, TIMEZONE, n)
}

// ────────────────────────── Express 应用 ──────────────────────────

const app = express()
app.disable('x-powered-by')
// 仅在显式配置 WEBUI_TRUST_PROXY 时才信任反向代理头（否则 XFF 可被伪造以绕过防爆破）
if (WEBUI_TRUST_PROXY) {
  const hop = parseInt(WEBUI_TRUST_PROXY, 10)
  app.set('trust proxy', Number.isInteger(hop) && hop > 0 ? hop : true)
}
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/** 请求来源 IP（统一入口，便于后续调整代理策略） */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/** 是否为回环地址来源（本机引导流程用） */
function isLoopback(req) {
  const ip = clientIp(req)
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** 计时安全的字符串比较（先散列到等长，避免时序侧信道） */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// 可选访问密码：/api/* 需要 X-WebUI-Key 头（SSE 可用 ?key= 查询参数）
app.use('/api', (req, res, next) => {
  if (!WEBUI_PASSWORD) return next()
  const key = req.headers['x-webui-key'] || req.query.key
  if (safeEqual(key, WEBUI_PASSWORD)) return next()
  return res.status(401).json({ error: '未授权：请在页面右上角输入访问密码', code: 'webui-auth' })
})

// 容器健康检查端点：刻意放在密码校验之外且不访问 /api/*，
// 否则设置了 WEBUI_PASSWORD 后健康检查会因 401 而被误判为不健康。
// 仅回传存活信息，不泄露账号数量、调度配置等任何细节。
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: Math.floor(process.uptime()) })
})

// ── 账号管理模块独立密码锁（防爆破）──
// 与全局访问密码相互独立。防爆破采用「IP + 目标账号」双维度：
//   - per-IP：防止单机对多个账号扫描；阈值放宽（同 NAT 用户不应互相拖累）
//   - per-账号：防止分布式撞库针对同一账号
// 任一维度达到阈值即锁定，成功登录时两个桶同时清零。
const failsByIp = new Map()   // ip     -> { fails, lockUntil, lastFailAt }
const failsByAcct = new Map() // userid -> { fails, lockUntil, lastFailAt }
const FAILS_MAP_MAX = 2000
const FAILS_TTL_MS = 24 * 60 * 60 * 1000

function bucketState(map, key) {
  let st = map.get(key)
  if (!st) {
    st = { fails: 0, lockUntil: 0, lastFailAt: 0 }
    map.set(key, st)
  }
  // 惰性清理：Map 过大时移除「未锁定且超过 TTL」的条目，避免无界增长
  if (map.size > FAILS_MAP_MAX) {
    const now = Date.now()
    for (const [k, v] of map) {
      if (v.lockUntil < now && now - v.lastFailAt > FAILS_TTL_MS) map.delete(k)
    }
  }
  return st
}

/** 记录一次失败；返回本次是否触发锁定 */
function registerFail(map, key, threshold, now) {
  const st = bucketState(map, key)
  st.fails++
  st.lastFailAt = now
  if (st.fails >= threshold) {
    st.lockUntil = now + ACCOUNTS_LOCK_MS
    st.fails = 0
    return true
  }
  return false
}

function clearFails(map, key) {
  const st = map.get(key)
  if (st) { st.fails = 0; st.lockUntil = 0 }
}

/** ── 每账号独立密码 + admin 管理员 ──
 * 密码哈希存于凭据同目录的 accounts_auth.json。
 * 存储格式：{ "<userid>": { algo:'scrypt', salt:'<hex>', hash:'<hex>' } }
 * 旧格式（裸 sha256 hex 字符串）在登录成功后惰性迁移为 scrypt。
 * 未设置过密码的账号，默认密码即其酷狗ID（便于用户登录后自助修改密码）；
 * 该行为可用 ACCOUNTS_DISABLE_ID_DEFAULT=true 关闭。
 * ⚠ 酷狗ID 并非秘密：保留默认密码意味着知道 ID 的人即可登录该账号并改密。
 * admin 为预留管理员账号，密码为环境变量 ACCOUNTS_PASSWORD（未设置则 admin 不可用）。
 */
const ACCOUNTS_AUTH_FILE = path.join(path.dirname(USERINFO_FILE), 'accounts_auth.json')

/** 旧版密码哈希（单轮 SHA-256 + 静态盐）——仅用于校验并迁移历史数据 */
function legacyHashAccountPassword(pwd) {
  return crypto.createHash('sha256').update(`kgcheckin:${pwd}`).digest('hex')
}

/** 生成 scrypt 密码记录 */
function makePasswordRecord(pwd) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex')
  return { algo: 'scrypt', salt, hash }
}

/** 校验密码：兼容旧格式；返回 { ok, needsRehash } */
function verifyPassword(pwd, stored) {
  if (typeof stored === 'string') {
    // 旧格式：静态盐 SHA-256
    return { ok: safeEqual(legacyHashAccountPassword(pwd), stored), needsRehash: true }
  }
  if (!stored || stored.algo !== 'scrypt' || !stored.salt || !stored.hash) {
    return { ok: false, needsRehash: false }
  }
  try {
    const expected = Buffer.from(stored.hash, 'hex')
    const actual = crypto.scryptSync(String(pwd), stored.salt, expected.length)
    return { ok: crypto.timingSafeEqual(actual, expected), needsRehash: false }
  } catch {
    return { ok: false, needsRehash: false }
  }
}

function readAccountsAuth() {
  try {
    // 兼容 UTF-8 BOM
    return JSON.parse(fs.readFileSync(ACCOUNTS_AUTH_FILE, 'utf8').replace(/^﻿/, '')) || {}
  } catch { return {} }
}

/** 凭据文件是否已初始化（用于判断是否需要 bootstrap admin） */
function accountsAuthExists() {
  try { return fs.existsSync(ACCOUNTS_AUTH_FILE) } catch { return false }
}

function saveAccountsAuth(map) {
  const tmp = `${ACCOUNTS_AUTH_FILE}.tmp`
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_AUTH_FILE), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    fs.renameSync(tmp, ACCOUNTS_AUTH_FILE)
    return true
  } catch (e) {
    printRed(`[webui] 写入账号密码文件失败：${e.message}`)
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    return false
  }
}

/** 启动时初始化：用 ACCOUNTS_BOOTSTRAP_PASSWORD 建立 admin 记录（仅首次） */
function bootstrapAccountsAuth() {
  if (!ACCOUNTS_BOOTSTRAP_PASSWORD) return
  if (accountsAuthExists()) return
  const map = { admin: makePasswordRecord(ACCOUNTS_BOOTSTRAP_PASSWORD) }
  if (saveAccountsAuth(map)) {
    printGreen('[webui] 已使用 ACCOUNTS_BOOTSTRAP_PASSWORD 初始化 admin 密码')
  }
}

/** 提取请求中提供的账号身份凭据（头 / 查询参数 / JSON body） */
function providedAccountsCreds(req) {
  const id = req.headers['x-accounts-id'] ?? req.query.id ?? req.body?.userid
  // 查询参数改用 accountsKey，避免与全局访问密码（?key=）及二维码 key 语义冲突
  const key = req.headers['x-accounts-key'] ?? req.query.accountsKey ?? req.body?.password
  return { id: id == null ? '' : String(id).trim(), key: key == null ? '' : String(key) }
}

/**
 * 校验身份。成功返回作用域 { admin:true } 或 { admin:false, userid, migrated }；
 * 失败返回 null；「需要先设置密码」返回 { needInitPassword:true }。
 */
function verifyAccountsCreds(id, key, req) {
  if (!id || !key) return null
  if (id === 'admin') {
    // admin 密码来源：ACCOUNTS_PASSWORD 环境变量，或 bootstrap 写入的哈希记录
    if (ACCOUNTS_PASSWORD && safeEqual(key, ACCOUNTS_PASSWORD)) return { admin: true }
    const storedAdmin = readAccountsAuth().admin
    if (storedAdmin) {
      const r = verifyPassword(key, storedAdmin)
      if (r.ok) return { admin: true }
    }
    return null
  }
  // 账号必须存在于凭据文件（防止任意 userid 探测登录）
  if (!readUserinfo().some(u => String(u.userid) === id)) return null

  const auth = readAccountsAuth()
  const stored = auth[id]

  if (!stored) {
    // 未设置过密码的账号：默认密码即酷狗ID（用户可凭此登录后自助修改密码）。
    //
    // ⚠ 安全提示：酷狗ID 并非秘密（账号列表接口会返回，用户之间也会互相告知），
    //   因此任何知道该 ID 的人都能登录此账号并修改密码，把号主锁在外面。
    //   该策略仅为"便于用户首次改密"而保留；若面板对公网暴露，建议：
    //     1) 设置 WEBUI_PASSWORD，或
    //     2) 由 admin 预先为各账号设置密码（设置后此分支不再生效），或
    //     3) 设置 ACCOUNTS_DISABLE_ID_DEFAULT=true 关闭该行为。
    if (ACCOUNTS_DISABLE_ID_DEFAULT) return { needInitPassword: true }
    if (safeEqual(key, id)) {
      return { admin: false, userid: id, mustChangePassword: true }
    }
    // 默认密码已启用但用户输入的不是酷狗ID：属于密码错误，必须计入失败次数，
    // 否则可对未设密码的账号无限次尝试（needInitPassword 不计失败）。
    return null
  }

  const { ok, needsRehash } = verifyPassword(key, stored)
  if (!ok) return null
  // 旧格式惰性迁移为 scrypt（失败不影响本次登录）
  if (needsRehash) {
    auth[id] = makePasswordRecord(key)
    saveAccountsAuth(auth)
  }
  return { admin: false, userid: id }
}

function accountsGuard(req, res, next) {
  const ip = clientIp(req)
  const now = Date.now()
  const ipSt = bucketState(failsByIp, ip)

  // 锁定期间一律拒绝（即使密码正确，防止绕过冷却继续尝试）
  if (ipSt.lockUntil > now) {
    const left = Math.ceil((ipSt.lockUntil - now) / 1000)
    return res.status(423).json({
      error: `账号管理已锁定，请 ${left} 秒后再试`,
      code: 'accounts-auth',
      retryAfter: left,
    })
  }

  const { id, key } = providedAccountsCreds(req)

  // per-账号锁定检查（与 IP 维度独立）
  if (id) {
    const acctSt = bucketState(failsByAcct, id)
    if (acctSt.lockUntil > now) {
      const left = Math.ceil((acctSt.lockUntil - now) / 1000)
      return res.status(423).json({
        error: `该账号尝试次数过多，请 ${left} 秒后再试`,
        code: 'accounts-auth',
        retryAfter: left,
      })
    }
  }

  // 未提供凭据不算失败：前端打开面板即会先请求，此处只提示需要凭据
  if (!id && !key) {
    return res.status(401).json({ error: '请输入酷狗ID和密码', code: 'accounts-auth', needPassword: true })
  }

  const scope = verifyAccountsCreds(id, key, req)

  if (scope && scope.needInitPassword) {
    // 未设置过密码且默认密码已被关闭（ACCOUNTS_DISABLE_ID_DEFAULT=true）
    return res.status(401).json({
      error: '该账号尚未设置密码，且默认密码已关闭；请联系管理员为其设置密码',
      code: 'accounts-auth',
      needInitPassword: true,
    })
  }

  if (scope) {
    clearFails(failsByIp, ip)
    if (id) clearFails(failsByAcct, id)
    req.accountsScope = scope
    return next()
  }

  // 失败：两个维度同时计数
  const acctLocked = id ? registerFail(failsByAcct, id, ACCOUNTS_MAX_ATTEMPTS, now) : false
  const ipLocked = registerFail(failsByIp, ip, ACCOUNTS_IP_MAX_ATTEMPTS, now)

  if (acctLocked) {
    printRed(`[webui] 账号管理：账号 ${maskIdentifier(id)} 连续 ${ACCOUNTS_MAX_ATTEMPTS} 次密码错误，锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
  }
  if (ipLocked) {
    printRed(`[webui] 账号管理：${ip} 连续 ${ACCOUNTS_IP_MAX_ATTEMPTS} 次密码错误，锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`)
    return res.status(423).json({
      error: `密码错误次数过多，已锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`,
      code: 'accounts-auth',
      retryAfter: Math.ceil(ACCOUNTS_LOCK_MS / 1000),
    })
  }
  if (acctLocked) {
    return res.status(423).json({
      error: `该账号密码错误次数过多，已锁定 ${ACCOUNTS_LOCK_MINUTES} 分钟`,
      code: 'accounts-auth',
      retryAfter: Math.ceil(ACCOUNTS_LOCK_MS / 1000),
    })
  }

  const acctLeft = id
    ? Math.max(0, ACCOUNTS_MAX_ATTEMPTS - bucketState(failsByAcct, id).fails)
    : Math.max(0, ACCOUNTS_MAX_ATTEMPTS - 1)
  printYellow(`[webui] 账号管理：${ip} 密码错误（第 ${ipSt.fails}/${ACCOUNTS_IP_MAX_ATTEMPTS} 次）`)
  return res.status(401).json({
    error: `酷狗ID或密码错误，剩余尝试次数 ${acctLeft}`,
    code: 'accounts-auth',
    attemptsLeft: acctLeft,
  })
}

app.use('/api/accounts', accountsGuard)

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/** 校验酷狗手机号格式 */
function assertPhone(phone) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) {
    const err = new Error('手机号格式不正确')
    err.status = 400
    throw err
  }
}

// ── 状态 ──
app.get('/api/status', wrap(async (req, res) => {
  res.json({
    bootAt: BOOT_AT,
    schedule: {
      cron: SCHEDULE,
      timezone: TIMEZONE,
      valid: cron.validate(SCHEDULE),
      nextRuns: nextRuns(3),
      // 复杂 cron 表达式无法预览，前端据此给出提示而非显示空白
      previewSupported: nextRuns(1).length > 0,
    },
    checkin: {
      running: checkinState.running,
      lastRun: checkinState.lastRun,
    },
    // 只暴露账号数量；账号明细走受独立密码保护的 GET /api/accounts
    accountCount: readUserinfo().length,
    accountsLockEnabled: true,
    apiServiceRunning: loginApi.running(),
  })
}))

// ── 扫码登录 ──
app.post('/api/qr/gen', wrap(async (req, res) => {
  const number = Math.min(5, Math.max(1, parseInt(req.body?.number, 10) || 1))
  const items = []
  await withApi(async () => {
    for (let n = 0; n < number; n++) {
      const r = await send(`/login/qr/key?timestrap=${Date.now()}`, 'GET', {})
      if (r?.status !== 1 || !r?.data?.qrcode) {
        const err = new Error(`获取二维码密钥失败（status=${r?.status ?? 'unknown'}）`)
        err.status = 502
        throw err
      }
      const key = r.data.qrcode
      const url = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`
      const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
      items.push({ key, url, dataUrl })
      if (number > 1 && n < number - 1) await delay(500)
    }
  })
  printMagenta(`[webui] 已生成 ${items.length} 个登录二维码，等待扫码...`)
  res.json({ items })
}))

app.get('/api/qr/status', wrap(async (req, res) => {
  // 参数名用 qrcode，避免与全局访问密码的 ?key= 语义冲突（旧名兼容一个版本）
  const key = String(req.query.qrcode || req.query.key || '').trim()
  if (!key) {
    const err = new Error('缺少 qrcode key')
    err.status = 400
    throw err
  }
  const result = await withApi(async () => {
    const r = await send(`/login/qr/check?key=${encodeURIComponent(key)}&timestrap=${Date.now()}`, 'GET', {})
    const s = r?.data?.status
    if (s === 4 && r?.data?.userid && r?.data?.token) {
      // 登录成功：凭据写入挂载卷（追加/更新，不动已有账号）
      const arr = readUserinfo()
      upsertUser(arr, { userid: String(r.data.userid), token: String(r.data.token) }, true)
      const saved = saveUserinfo(arr)
      return { status: 4, userid: maskIdentifier(r.data.userid), saved }
    }
    return { status: s ?? -1 }
  })
  if (result.status === 4) {
    printGreen(`[webui] 扫码登录成功，账号 ${result.userid} 已${result.saved ? '保存到凭据文件' : '获取（写文件失败）'}`)
  }
  res.json(result)
}))

// ── 手机号登录 ──

/** 把酷狗上游响应转成可读的错误描述（区分业务错误 / 风控 / 网络层异常） */
function describeUpstreamError(r) {
  if (r?.ssaCode) return '触发酷狗安全验证（风控），请稍后再试或改用扫码登录'
  if (r?.error_code != null) {
    return `${r.data || r.msg || '发送被拒绝'}（error_code ${r.error_code}）`
  }
  if (r?.msg && typeof r.msg === 'object') {
    // request.js 网络层异常时 msg 是 axios 错误对象
    return `请求酷狗服务失败：${r.msg.message || r.msg.code || '网络异常'}`
  }
  return r?.msg || r?.message || `status=${r?.status ?? 'unknown'}`
}

app.post('/api/phone/send', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  assertPhone(phone)
  const r = await withApi(() => send(`/captcha/sent?mobile=${phone}`, 'GET', {}))
  if (r?.status !== 1) {
    const err = new Error(`验证码发送失败：${describeUpstreamError(r)}`)
    err.status = 502
    throw err
  }
  printGreen(`[webui] 验证码已发送至 ${phone.slice(0, 2)}*******${phone.slice(-2)}`)
  // 成功响应体也记录（脱敏后），便于短信未送达时诊断上游行为
  printYellow(`[webui] 发送响应: ${JSON.stringify(summarizeResponse(r))}`)
  res.json({ ok: true })
}))

app.post('/api/phone/login', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  const code = String(req.body?.code || '').trim()
  assertPhone(phone)
  if (!/^\d{4,6}$/.test(code)) {
    const err = new Error('验证码格式不正确')
    err.status = 400
    throw err
  }
  const r = await withApi(() => send(`/login/cellphone?mobile=${phone}&code=${code}`, 'GET', {}))
  if (r?.status === 1 && r?.data?.userid && r?.data?.token) {
    const arr = readUserinfo()
    upsertUser(arr, { userid: String(r.data.userid), token: String(r.data.token) }, true)
    const saved = saveUserinfo(arr)
    const userid = maskIdentifier(r.data.userid)
    printGreen(`[webui] 手机号登录成功，账号 ${userid} 已保存`)
    return res.json({ ok: true, userid, saved })
  }
  if (r?.error_code === 34175) {
    const err = new Error('该手机号绑定了多个酷狗账号，暂不支持手机号登录，请使用扫码登录')
    err.status = 400
    throw err
  }
  const err = new Error(`登录失败：${describeUpstreamError(r)}`)
  err.status = 401
  throw err
}))

// ── 一键签到 ──
app.post('/api/checkin/run', wrap(async (req, res) => {
  if (checkinState.running) {
    const err = new Error('签到任务正在进行中，请稍候')
    err.status = 409
    throw err
  }
  const accounts = readUserinfo()
  if (!accounts.length && !process.env.USERINFO) {
    const err = new Error('尚未配置任何账号凭据，请先登录')
    err.status = 400
    throw err
  }
  startCheckin('manual')
  res.status(202).json({ ok: true })
}))

app.get('/api/checkin/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({
    running: checkinState.running,
    lastRun: checkinState.lastRun,
    replayed: checkinState.logs.length,
  })}\n\n`)
  for (const entry of checkinState.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  checkinState.sseClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
  }, 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    checkinState.sseClients.delete(res)
  })
})

// ── 账号管理（受 accountsGuard 保护：每账号独立密码，admin 可管理全部）──

/** 验证身份凭据（解锁面板用）；失败计数与锁定由 accountsGuard 统一处理 */
app.post('/api/accounts/unlock', wrap(async (req, res) => {
  res.json({ ok: true, admin: req.accountsScope.admin })
}))

/** 账号管理面板展示用：解析账号昵称（完整、不脱敏；面板本身受独立密码保护）。
 *  凭据文件已存昵称时直接返回；缺失时经 /user/detail 懒加载并回写文件。
 *  单个账号失败（token 过期/网络异常等）不影响其余账号，也不阻断列表接口。
 *  注意：不得在日志中输出完整昵称。 */
async function resolveAccountNicknames(accounts) {
  const missing = accounts.filter(u => !u.nickname)
  if (missing.length) {
    try {
      await withApi(async () => {
        for (const u of missing) {
          try {
            const headers = { cookie: `token=${u.token}; userid=${u.userid}` }
            const detail = await send(`/user/detail?timestrap=${Date.now()}`, 'GET', headers)
            if (detail?.data?.nickname != null) u.nickname = String(detail.data.nickname)
          } catch { /* 单账号失败跳过，保持无昵称 */ }
        }
      })
    } catch { /* API 服务不可用：本次仅返回已存昵称 */ }
    if (missing.some(u => u.nickname)) {
      // 回写昵称（含完整 token，仅写本地凭据文件；失败不致命，下次加载会重新懒加载）
      saveUserinfo(readUserinfo().map(u => {
        const found = accounts.find(a => String(a.userid) === String(u.userid))
        return found && found.nickname ? { ...u, nickname: found.nickname } : u
      }))
    }
  }
  return accounts.map(u => (u.nickname ? String(u.nickname) : null))
}

/** 按身份作用域过滤账号：admin 见全部；普通用户仅见自己 */
function scopeFilter(accounts, scope) {
  if (scope.admin) return accounts.map((u, i) => ({ u, i }))
  return accounts.map((u, i) => ({ u, i })).filter(({ u }) => String(u.userid) === scope.userid)
}

app.get('/api/accounts', wrap(async (req, res) => {
  const scope = req.accountsScope
  const all = readUserinfo()
  const visible = scopeFilter(all, scope)
  const nicknames = await resolveAccountNicknames(visible.map(v => v.u))
  const auth = readAccountsAuth()
  res.json({
    accounts: visible.map(({ u, i }, vi) => ({
      index: i,
      userid: maskIdentifier(u.userid),
      // 完整 userid 仅用于前端发起按 id 的删除（面板本身已受独立密码保护）
      rawUserid: String(u.userid),
      nickname: nicknames[vi],
      tokenLength: String(u.token || '').length,
      // 是否已自行设置过密码：false 表示当前仍在使用「酷狗ID」作为默认密码
      hasPassword: Boolean(auth[String(u.userid)]),
    })),
    admin: scope.admin,
    lockEnabled: true,
    // 以默认密码（酷狗ID）登录时为 true，前端据此提示尽快改密
    mustChangePassword: Boolean(scope.mustChangePassword),
  })
}))

/** 按 userid 删除账号（推荐）：避免前端缓存下标与列表不一致时删错账号 */
app.delete('/api/accounts/by-id/:userid', wrap(async (req, res) => {
  const scope = req.accountsScope
  const targetId = String(req.params.userid || '').trim()
  const arr = readUserinfo()
  const index = arr.findIndex(u => String(u.userid) === targetId)
  if (index === -1) {
    const err = new Error('账号不存在')
    err.status = 404
    throw err
  }
  if (!scope.admin && targetId !== scope.userid) {
    const err = new Error('只能删除自己的账号')
    err.status = 403
    throw err
  }
  arr.splice(index, 1)
  saveUserinfo(arr)
  const auth = readAccountsAuth()
  if (targetId in auth) {
    delete auth[targetId]
    saveAccountsAuth(auth)
  }
  printYellow(`[webui] 已删除账号 ${maskIdentifier(targetId)}，剩余 ${arr.length} 个账号`)
  res.json({ ok: true, remaining: arr.length })
}))

app.delete('/api/accounts/:index', wrap(async (req, res) => {
  const scope = req.accountsScope
  const index = parseInt(req.params.index, 10)
  const arr = readUserinfo()
  if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
    const err = new Error('账号序号不存在')
    err.status = 404
    throw err
  }
  // TOCTOU 防护：调用方传入的 expectUserid 必须与当前下标对应的账号一致，
  // 否则说明列表在用户操作期间已变化，拒绝删除以免误删他人账号。
  const expectUserid = req.query.expectUserid != null ? String(req.query.expectUserid).trim() : ''
  if (expectUserid && String(arr[index].userid) !== expectUserid) {
    const err = new Error('账号列表已变化，请刷新后重试')
    err.status = 409
    throw err
  }
  // 非 admin 只能删除自己的账号
  if (!scope.admin && String(arr[index].userid) !== scope.userid) {
    const err = new Error('只能删除自己的账号')
    err.status = 403
    throw err
  }
  const removedUserid = String(arr[index].userid)
  const removed = maskIdentifier(removedUserid)
  arr.splice(index, 1)
  saveUserinfo(arr)
  // 清理该账号的自定义密码（若存在）
  const auth = readAccountsAuth()
  if (removedUserid in auth) {
    delete auth[removedUserid]
    saveAccountsAuth(auth)
  }
  printYellow(`[webui] 已删除账号 ${removed}，剩余 ${arr.length} 个账号`)
  res.json({ ok: true, remaining: arr.length })
}))

/** 修改账号密码：普通用户只能改自己；admin 可改任意账号（body.targetUserid 指定目标）。
 *  admin 自身的密码可由此处修改（写入 accounts_auth.json），环境变量 ACCOUNTS_PASSWORD 仍优先生效。 */
app.post('/api/accounts/password', wrap(async (req, res) => {
  const scope = req.accountsScope
  const newPwd = String(req.body?.newPassword || '')
  if (!newPwd || newPwd.length < 4 || newPwd.length > 64) {
    const err = new Error('新密码长度需为 4-64 位')
    err.status = 400
    throw err
  }
  // 目标账号：admin 显式指定 targetUserid（缺省即 admin 自身）；普通用户固定为自己
  const targetUserid = scope.admin
    ? (req.body?.targetUserid ? String(req.body.targetUserid) : 'admin')
    : scope.userid

  if (targetUserid !== 'admin' && !readUserinfo().some(u => String(u.userid) === targetUserid)) {
    const err = new Error('目标账号不存在')
    err.status = 404
    throw err
  }

  const auth = readAccountsAuth()
  auth[targetUserid] = makePasswordRecord(newPwd)
  if (!saveAccountsAuth(auth)) {
    const err = new Error('密码写入失败，请检查凭据目录权限')
    err.status = 500
    throw err
  }
  printYellow(`[webui] 账号 ${targetUserid === 'admin' ? 'admin' : maskIdentifier(targetUserid)} 的密码已更新`)
  res.json({ ok: true })
}))

// ── 兜底 ──
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) printRed(`[webui] ${req.method} ${req.path} 失败：${err.message}`)
  res.status(status).json({ error: err.message })
})

// ────────────────────────── 启动 ──────────────────────────

const BANNER = `
  ┌─────────────────────────────────────┐
  │   kgcheckin webui  ·  酷狗概念签到   │
  └─────────────────────────────────────┘`

// 首次启动：若配置了 ACCOUNTS_BOOTSTRAP_PASSWORD 且尚无密码文件，则初始化 admin
bootstrapAccountsAuth()

app.listen(WEBUI_PORT, () => {
  console.log(BANNER)
  printGreen(`[webui] 控制台已启动: http://127.0.0.1:${WEBUI_PORT}`)
  printYellow(`  计划任务: ${cron.validate(SCHEDULE) ? SCHEDULE : `${SCHEDULE} (无效！定时签到未启用)`}（${TIMEZONE}）`)
  printYellow(`  下次执行: ${nextRuns(1)[0] || '-'}`)
  printYellow(`  凭据文件: ${USERINFO_FILE}（${readUserinfo().length} 个账号）`)
  printYellow(`  访问密码: ${WEBUI_PASSWORD ? '已启用' : '未启用（仅建议在可信内网使用）'}`)
  printYellow(`  账号管理: 每账号独立密码（scrypt）· admin ${ACCOUNTS_PASSWORD || readAccountsAuth().admin ? '已启用' : '未启用'} · 账号 ${ACCOUNTS_MAX_ATTEMPTS} 次 / IP ${ACCOUNTS_IP_MAX_ATTEMPTS} 次错误锁定 ${Math.round(ACCOUNTS_LOCK_MINUTES)} 分钟`)
  if (ACCOUNTS_DISABLE_ID_DEFAULT) {
    printYellow('  账号默认密码: 已关闭（未设密码的账号需由 admin 设置密码后才能登录）')
  } else {
    printYellow('  ⚠ 账号默认密码 = 酷狗ID（便于用户首次登录后自行改密）')
    printYellow('    酷狗ID 在账号列表与用户之间可见，知道 ID 即可登录该账号并改密；')
    printYellow('    公网部署建议设置 WEBUI_PASSWORD，或设 ACCOUNTS_DISABLE_ID_DEFAULT=true 并分发密码。')
  }
  if (!readAccountsAuth().admin && !ACCOUNTS_PASSWORD) {
    printYellow('  提示：未配置 ACCOUNTS_PASSWORD，admin 不可用；可设 ACCOUNTS_BOOTSTRAP_PASSWORD 初始化 admin 密码')
  }
  if (WEBUI_TRUST_PROXY) {
    printYellow(`  反向代理: 已信任 X-Forwarded-For（WEBUI_TRUST_PROXY=${WEBUI_TRUST_PROXY}）`)
  }

  if (cron.validate(SCHEDULE)) {
    cron.schedule(SCHEDULE, () => {
      if (checkinState.running) {
        printYellow('[webui] 上一次签到任务尚未结束，跳过本次定时触发')
        return
      }
      startCheckin('cron')
    }, { timezone: TIMEZONE })
  }

  if (RUN_ON_STARTUP) {
    printYellow('[webui] RUN_ON_STARTUP=true，即将执行一次启动签到')
    setTimeout(() => startCheckin('startup'), 2000)
  }
})
