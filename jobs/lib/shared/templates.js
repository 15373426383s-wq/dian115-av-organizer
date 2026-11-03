import { Template, Environment, Interpreter } from './vendor/jinja.js'

const MAX_OUTPUT = 1024 * 1024
const runtime = value => { const env = new Environment(); env.set('v', value); return env.lookupVariable('v') }
const plain = value => value?.value instanceof Map ? Object.fromEntries([...value.value].map(([k, v]) => [k, plain(v)])) : Array.isArray(value?.value) ? value.value.map(plain) : value?.value
class BoundedInterpreter extends Interpreter {
  constructor(env, transform) { super(env); this.steps = 0; this.depth = 0; this.transform = transform; this.outputBudget = 0 }
  evaluate(node, env) {
    if (++this.steps > 30000 || ++this.depth > 160) throw new Error('模板计算超过限制')
    try { const value = super.evaluate(node, env); if(node.type==='StringLiteral' && typeof value?.value==='string') { this.outputBudget += value.value.length; if(this.outputBudget>MAX_OUTPUT)throw new Error('模板输出过长') } if (typeof value?.value === 'string' && value.value.length > MAX_OUTPUT) throw new Error('模板输出过长'); return value }
    finally { this.depth-- }
  }
  evaluateBinaryExpression(node, env) {
    const op=node.operator.value
    if(op!=='*' && op!=='**')return super.evaluateBinaryExpression(node,env)
    const a=plain(this.evaluate(node.left,env)),b=plain(this.evaluate(node.right,env))
    if(op==='**') {if(typeof a!=='number' || typeof b!=='number' || Math.abs(b)>32 || !Number.isFinite(a**b))throw new Error('模板指数超过限制');return runtime(a**b)}
    const value=typeof a==='string' || Array.isArray(a)?a:b,count=value===a?b:a
    if(typeof value==='string' || Array.isArray(value)) {
      if(!Number.isInteger(count) || value.length*Math.max(0,count)>(Array.isArray(value)?10000:MAX_OUTPUT))throw new Error('模板重复内容过长')
      return runtime(typeof value==='string'?value.repeat(Math.max(0,count)):Array.from({length:Math.max(0,count)},()=>value).flat())
    }
    if(typeof a!=='number' || typeof b!=='number')throw new Error('乘法只支持数值、字符串或列表')
    return runtime(a*b)
  }
  applyFilter(operand, filter, env) {
    const name = filter.type === 'CallExpression' ? filter.callee.value : filter.value
    if(!['__out','default','d','truncate','split','urlencode','json_escape','title','capitalize','indent','tojson'].includes(name))return super.applyFilter(operand,filter,env)
    const evaluated=filter.type==='CallExpression'?this.evaluateArguments(filter.args,env):[[],new Map()]
    const args=evaluated[0].map(plain),kwargs=Object.fromEntries([...evaluated[1]].map(([k,v])=>[k,plain(v)]))
    const value = plain(operand), text = () => String(value ?? '')
    if(name==='tojson'){const indent=Number(kwargs.indent ?? args[0] ?? 0);if(!Number.isInteger(indent)||indent<0||indent>10)throw new Error('JSON 缩进最多 10 个字符');return runtime(JSON.stringify(value ?? null,null,indent))}
    if(name==='indent'){const width=Number(kwargs.width ?? args[0] ?? 4);if(!Number.isInteger(width)||width<0||width>100)throw new Error('缩进超过限制');return runtime(text().split('\n').map((s,i)=>(!i && !(kwargs.first ?? args[1]) || !s && !(kwargs.blank ?? args[2]))?s:' '.repeat(width)+s).join('\n'))}
    if (name === '__out') { const rendered=this.transform(value ?? ''); this.outputBudget += String(rendered).length; if(this.outputBudget>MAX_OUTPUT)throw new Error('模板输出过长'); return runtime(rendered) }
    if (name === 'default' || name === 'd') return runtime(value === undefined || value === null || value === '' || (args[1] && !value) ? args[0] ?? '' : value)
    if (name === 'truncate') return runtime([...text()].slice(0, Math.min(10000, Math.max(0, Number(args[0] ?? 60)))).join(''))
    if (name === 'split') return runtime(text().split(String(args[0] ?? ',')))
    if (name === 'urlencode') return runtime(encodeURIComponent(text()))
    if (name === 'json_escape') return runtime(JSON.stringify(value ?? '').slice(1, -1))
    if (name === 'title') return runtime(text().replace(/\b\w/g, v => v.toUpperCase()))
    if (name === 'capitalize') return runtime(text().slice(0, 1).toUpperCase() + text().slice(1).toLowerCase())
    return super.applyFilter(operand, filter, env)
  }
}
export function renderText(template, vars = {}, transform = value => String(value ?? '')) {
  let source = String(template || '')
  if (source.length > 32768 || JSON.stringify(vars).length > 256 * 1024) throw new Error('模板或变量超过长度限制')
  if (/\b(?:__proto__|prototype|constructor)\b/.test(source)) throw new Error('模板不支持访问内部属性')
  const blocks = []
  for (const match of source.matchAll(/\{%\s*(\w+)[\s\S]*?%\}/g)) {
    const word = match[1]
    if (['if','for','macro'].includes(word)) blocks.push(word)
    else if (['endif','endfor','endmacro'].includes(word) && blocks.pop() !== word.slice(3)) throw new Error(`模板 ${word} 没有对应起始语句`)
  }
  if (blocks.length) throw new Error(`模板缺少 end${blocks.at(-1)}`)
  source = source.replace(/(?<!\{)\{([a-z_][\w]*)\}(?!\})/g, (all, key) => vars[key] === undefined ? all : `{{ ${key} }}`)
  source = source.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => `{{ (${expr.trim()}) | __out }}`)
  try {
    const template = new Template(source), env = new Environment()
    for (const [key, value] of Object.entries({ false: false, true: true, none: null, False: false, True: true, None: null, ...vars })) {
      if (['range','namespace', '__proto__', 'constructor', 'prototype'].includes(key)) continue
      env.set(key, value)
    }
    env.set('range', (...args) => { const [start, stop, step] = args.length === 1 ? [0,args[0],1] : [args[0],args[1],args[2] ?? 1]; if (![start,stop,step].every(Number.isFinite) || !step || Math.ceil((stop-start)/step)>1000) throw new Error('range 最多生成 1000 项'); const out=[]; for(let n=start;step>0?n<stop:n>stop;n+=step) out.push(n); return out })
    return new BoundedInterpreter(env, transform).run(template.parsed).value
  } catch (e) { throw new Error(`模板不支持或语法错误：${e.message || e}`) }
}
export function evaluate(text, vars = {}) { return renderText(`{{ ${text} }}`, vars) }
export function evaluateCondition(text, vars = {}) { return renderText(`{% if ${text} %}1{% else %}0{% endif %}`, vars) === '1' }
