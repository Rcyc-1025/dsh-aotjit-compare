import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../lib/index.js';

function fakeContext({ spawnThrows = true } = {}) {
  const registered = [];
  const listeners = new Map();
  const spawns = [];
  return {
    registered,
    listeners,
    spawns,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {
          const index = registered.indexOf(definition);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    subprocess: {
      spawn(spec) {
        spawns.push(spec);
        if (spawnThrows) throw new Error('本测试不应 spawn');
        return { done: Promise.resolve({ exitCode: 0, signal: null }) };
      },
      resolveExecutable(command) {
        return `C:/resolved/${command}`;
      },
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
}

test('插件契约：name / inject 与规格一致', () => {
  assert.equal(name, 'aotjit-compare');
  assert.deepEqual(inject, ['subprocess', 'tools']);
});

test('apply：只注册一个工具，名字是 aotjit_compare', () => {
  const ctx = fakeContext();
  apply(ctx, undefined);
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].name, 'aotjit_compare');
  assert.equal(typeof ctx.registered[0].execute, 'function');
  assert.equal(typeof ctx.registered[0].output.render, 'function');
});

test('apply：加载期不 spawn、不探测路径', () => {
  const ctx = fakeContext();
  apply(ctx, { timeoutMs: 1, logDir: 'x' });
  assert.deepEqual(ctx.spawns, []);
});

test('apply：工具 schema 的 required 只有 jitSpec 与 cases', () => {
  const ctx = fakeContext();
  apply(ctx, undefined);
  const params = ctx.registered[0].parameters;
  assert.deepEqual(params.required, ['jitSpec', 'cases']);
  assert.equal(params.additionalProperties, false);
  for (const key of ['aotExe', 'aotArgs', 'jitSpec', 'cases', 'timeoutMs', 'workDir', 'compare', 'normalize', 'maxOutputBytes', 'tag', 'saveArtifacts']) {
    assert.equal(key in params.properties, true, `缺少参数 ${key}`);
  }
});

test('apply：配置非法也不抛，仍注册工具', () => {
  const ctx = fakeContext();
  assert.doesNotThrow(() => apply(ctx, { timeoutMs: 'x', compare: 'nope', normalize: 3 }));
  assert.equal(ctx.registered.length, 1);
});

test('apply：dispose 时反注册（调用 disposer）', () => {
  const ctx = fakeContext();
  apply(ctx, undefined);
  assert.equal(ctx.registered.length, 1);
  const handler = ctx.listeners.get('dispose');
  assert.equal(typeof handler, 'function');
  handler();
  assert.equal(ctx.registered.length, 0);
});

test('apply：没有 ctx.on 时不报错', () => {
  const ctx = fakeContext();
  delete ctx.on;
  assert.doesNotThrow(() => apply(ctx, undefined));
  assert.equal(ctx.registered.length, 1);
});

test('apply：缺少 resolveExecutable 时仍能注册（走本地路径校验）', () => {
  const ctx = fakeContext();
  delete ctx.subprocess.resolveExecutable;
  assert.doesNotThrow(() => apply(ctx, undefined));
  assert.equal(ctx.registered.length, 1);
});
