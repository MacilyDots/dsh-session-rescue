import { apply as guard } from './lib/degen-guard/index.js'
import { apply as retry } from './lib/retry/index.js'
import { apply as wiretap } from './lib/wiretap/index.js'
import { apply as inherit } from './lib/inherit/index.mjs'
export { Config } from './lib/degen-guard/config-schema.js'
export const name = 'dsh-session-rescue'

export function apply(ctx, config = {}) {
  if (config.retryEnabled !== false) retry(ctx, config.retry || {})
  // wiretap 后安装，位于 retry 外层；它看到重试后的响应。
  if (config.wiretapEnabled === true) wiretap(ctx, { ...config.wiretap, enabled: true })
  if (config.guardEnabled !== false) guard(ctx, config)
  if (config.inheritEnabled !== false) ctx.inject(['agents'], host => inherit(host, config.inherit || {}))
}
