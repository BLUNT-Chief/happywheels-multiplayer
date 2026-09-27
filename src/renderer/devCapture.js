// DEV ONLY: capture dynamically evaluated code (the game unpacks its real source at runtime)
// so it can be studied offline. Never active in release builds.

export function installDevCapture() {
  const captured = [];
  window.__hwmpCaptured = captured;
  const nativeToString = Function.prototype.toString;
  const disguised = new WeakMap();
  const NativeFunction = Function;

  function record(kind, args) {
    const body = args.length ? String(args[args.length - 1]) : '';
    if (body.length > 20000) captured.push({ kind, params: args.slice(0, -1).map(String), body });
  }

  const FakeFunction = function Function(...args) {
    record('Function', args);
    return NativeFunction(...args);
  };
  FakeFunction.prototype = NativeFunction.prototype;
  disguised.set(FakeFunction, 'function Function() { [native code] }');

  const nativeEval = window.eval;
  const fakeEval = function (code) {
    if (typeof code === 'string') record('eval', [code]);
    return nativeEval(code);
  };
  disguised.set(fakeEval, 'function eval() { [native code] }');

  const fakeToString = function toString() {
    if (disguised.has(this)) return disguised.get(this);
    return nativeToString.call(this);
  };
  disguised.set(fakeToString, 'function toString() { [native code] }');

  Function.prototype.toString = fakeToString;
  Object.defineProperty(NativeFunction.prototype, 'constructor', { value: FakeFunction, writable: true, configurable: true });
  window.Function = FakeFunction;
  window.eval = fakeEval;
}
