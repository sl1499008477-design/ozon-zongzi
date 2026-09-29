export async function loginAndRefreshCurrentPage({
  credentials,
  request,
  applyLoginState,
  refreshPageState,
}) {
  const response = await request('/local/accounts/login?view=bootstrap', {
    method: 'POST',
    body: credentials,
  });
  await applyLoginState({
    ...(response.state || {}),
    ...(response.token ? {token: response.token} : {}),
    __webStatePath: '/local/state?view=bootstrap',
  });
  await refreshPageState({source: 'account-login'});
  return response;
}

export function createAppAccountLoginHandler({
  isLoggingIn,
  setLoggingIn,
  request,
  applyLocalState,
  refreshLocalState,
  showSuccess,
  showError,
  currentRoute,
  navigate,
}) {
  return async function handleAccountLogin(values) {
    if (isLoggingIn()) return;
    setLoggingIn(true);
    try {
      const response = await loginAndRefreshCurrentPage({
        credentials: {
          username: values.username,
          password: values.password,
        },
        request,
        applyLoginState: applyLocalState,
        refreshPageState: refreshLocalState,
      });
      showSuccess('登录成功');
      if (currentRoute() === '/404') navigate('/ozon/dashboard');
      return response;
    } catch (error) {
      showError(error.message || '登录失败');
      return null;
    } finally {
      setLoggingIn(false);
    }
  };
}
