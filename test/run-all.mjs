// 统一测试入口：跑全部模块测试 + 整合包验收断言。
// 不联网、不写正式 DSH_HOME；所有落盘都指向临时目录。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-rescue-tests-'))
const env = { ...process.env, DSH_HOME: home }

// node:test 文件（并行跑；integration 自带独立 HOME 前缀，互不冲突）
const testFiles = [
  'integration.test.mjs',
  'branches.test.mjs', 'contract.test.mjs', 'extract.test.mjs',
  'host.test.mjs', 'inherit-service.test.mjs',
]
// 传统 assert 脚本（单文件串行）
const scripts = [
  'test-detect.mjs', 'test-request-tap.mjs', 'test-plugin.mjs', 'test-recovery.mjs',
  'test-sse.mjs', 'test-wiretap.mjs', 'test-request-object.mjs', 'test-retry.mjs',
]

let failed = 0
function run(label, args) {
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  const ok = r.status === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    failed += 1
    console.log(out.split('\n').slice(-25).join('\n'))
  }
  return ok
}

for (const f of testFiles) run(f, ['--test', join(root, f)])
for (const s of scripts) run(s, [join(root, s)])

rmSync(home, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL GREEN' : `${failed} SUITE(S) FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
