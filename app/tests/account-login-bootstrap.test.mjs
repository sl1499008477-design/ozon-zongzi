import assert from 'node:assert/strict';
import test from 'node:test';
const loginBootstrap = await import('../src/account-login-bootstrap.js').catch(() => ({}));

test('login applies bootstrap identity before refreshing the current deep-link view', async () => {
  assert.equal(typeof loginBootstrap.loginAndRefreshCurrentPage, 'function');
  const events = [];
  const response = await loginBootstrap.loginAndRefreshCurrentPage({
    credentials: {username: 'fixture-user', password: 'fixture-password'},
    request: async (path, options) => {
      events.push({type: 'request', path, options});
      return {token: 'fixture-token', state: {account: {id: 'account-a'}, stores: [{id: 'store-a'}]}};
    },
    applyLoginState: async state => events.push({type: 'identity', state}),
    refreshPageState: async options => events.push({type: 'refresh', options}),
  });

  assert.equal(response.token, 'fixture-token');
  assert.equal(events[0].path, '/local/accounts/login?view=bootstrap');
  assert.deepEqual(events[0].options, {
    method: 'POST',
    body: {username: 'fixture-user', password: 'fixture-password'},
  });
  assert.deepEqual(events[1], {
    type: 'identity',
    state: {
      account: {id: 'account-a'},
      stores: [{id: 'store-a'}],
      token: 'fixture-token',
      __webStatePath: '/local/state?view=bootstrap',
    },
  });
  assert.deepEqual(events[2], {type: 'refresh', options: {source: 'account-login'}});
});

test('App login handler connects its local-state applier to bootstrap login', async () => {
  assert.equal(typeof loginBootstrap.createAppAccountLoginHandler, 'function');
  const events = [];
  const handleAccountLogin = loginBootstrap.createAppAccountLoginHandler({
    isLoggingIn: () => false,
    setLoggingIn: value => events.push({type: 'logging', value}),
    request: async (path, options) => {
      events.push({type: 'request', path, options});
      return {token: 'fixture-token', state: {account: {id: 'account-a'}}};
    },
    applyLocalState: async state => events.push({type: 'identity', state}),
    refreshLocalState: async options => events.push({type: 'refresh', options}),
    showSuccess: text => events.push({type: 'success', text}),
    showError: text => events.push({type: 'error', text}),
    currentRoute: () => '/ozon/collect/edit',
    navigate: path => events.push({type: 'navigate', path}),
  });

  await handleAccountLogin({username: 'fixture-user', password: 'fixture-password'});

  assert.deepEqual(events, [
    {type: 'logging', value: true},
    {
      type: 'request',
      path: '/local/accounts/login?view=bootstrap',
      options: {method: 'POST', body: {username: 'fixture-user', password: 'fixture-password'}},
    },
    {
      type: 'identity',
      state: {
        account: {id: 'account-a'},
        token: 'fixture-token',
        __webStatePath: '/local/state?view=bootstrap',
      },
    },
    {type: 'refresh', options: {source: 'account-login'}},
    {type: 'success', text: '登录成功'},
    {type: 'logging', value: false},
  ]);
});
