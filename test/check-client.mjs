import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def } } }

try {
  new Function('window', code)(fakeWindow)
} catch (error) {
  console.log('LOAD FAILED:', error.message)
  process.exit(1)
}
console.log('load ok, id =', captured?.id)

const React = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
}

try {
  const mod = captured.factory((name) => (name === 'react' ? React : {}))
  console.log('factory ok, keys =', Object.keys(mod || {}))
} catch (error) {
  console.log('FACTORY FAILED:', error.message)
  console.log(error.stack)
  process.exit(1)
}