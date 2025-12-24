import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import esbuild from 'esbuild'
import { createRequire } from 'node:module'

const {
  values: { format },
  positionals,
} = parseArgs({
  // 定义命令行参数
  options: {
    format: {
      type: 'string', // 参数数据类型
      short: 'f', // 参数短名 可以用 -f 代替 --format
      default: 'esm', // 默认值 如果没有传入该参数 则使用默认值
    },
  },
  // 位置参数（非选项参数） 是否允许出现未定义的选项
  allowPositionals: true,
})

// 获取打包目标模块名称 如果没有传入则默认为 'vue'
const target = positionals.length ? positionals?.[0] : 'vue'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 入口文件 统一为模块名称下的 scr/index.ts 文件
const entry = resolve(__dirname, `../packages/${target}/src/index.ts`)

/**
 * 打包输出文件
 * --format esm | cjs
 * esm -> xxx.esm.js
 * cjs -> xxx.cjs.js
 */
const outfile = resolve(
  __dirname,
  `../packages/${target}/dist/${target}.${format}.js`,
)

const require = createRequire(import.meta.url)
// 获取打包模块的package.json
const pkg = require(`../packages/${target}/package.json`)

// 配置esbuild打包选项
esbuild
  .context({
    entryPoints: [entry], // 入口文件
    outfile, // 输出文件
    format, // 输出格式 esm 或 cjs
    platform: format === 'cjs' ? 'node' : 'browser', // 打包平台 node 或 browser(浏览器)
    sourcemap: true, // 生成 sourcemap 文件 方便调试
    bundle: true, // 启用打包 将所有依赖打包到一个文件中
    globalName: pkg.buildOptions.name, // 全局变量名称
  })
  .then(ctx => ctx.watch()) // 启用监听模式 代码变更时自动重新打包
  .catch(() => process.exit(1)) // 捕获错误并退出进程
