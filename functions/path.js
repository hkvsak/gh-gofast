const PREFIX = '/';

const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com'
]);

const GITHUB_PATH_PATTERNS = [
  /^\/[^/]+\/[^/]+\/(?:releases|archive)\/.+/i,
  /^\/[^/]+\/[^/]+\/(?:blob|raw)\/.+/i,
  /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/i,
  /^\/[^/]+\/[^/]+\/tags(?:\/.*)?$/i,
];

function isAllowedGitHubUrl(url) {
  if (!url || url.protocol !== 'https:') {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(host)) {
    return false;
  }

  const path = url.pathname;

  if (host === 'github.com' || host === 'www.github.com') {
    return GITHUB_PATH_PATTERNS.some(re => re.test(path));
  }

  if (host === 'raw.githubusercontent.com') {
    return /^\/[^/]+\/[^/]+\/.+/i.test(path);
  }

  if (host === 'gist.githubusercontent.com') {
    return /^\/[^/]+\/[^/]+\/.+/i.test(path);
  }

  if (host === 'objects.githubusercontent.com' ||
      host === 'release-assets.githubusercontent.com') {
    return true;
  }

  if (host === 'codeload.github.com') {
    return /^\/[^/]+\/[^/]+\/.+/i.test(path);
  }

  return false;
}

function normalizeTargetUrl(rawInput, search = '') {
  if (!rawInput) return null;

  let normalized = rawInput.trim();

  normalized = normalized.replace(
    /^(https?:)\/+/i,
    '$1//'
  );

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized;
  }

  try {
    const target = new URL(normalized);

    if (search) {
      target.search = search;
    }

    return target;
  } catch {
    return null;
  }
}

function corsHeaders(headers, exposeAll = false) {
  const result = new Headers(headers);

  result.set('Access-Control-Allow-Origin', '*');

  if (exposeAll) {
    result.set('Access-Control-Expose-Headers', '*');
  }

  result.delete('Content-Security-Policy');
  result.delete('Content-Security-Policy-Report-Only');
  result.delete('Clear-Site-Data');

  return result;
}

function createError(message, status = 502) {
  return new Response(message, {
    status,
    headers: corsHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })
  });
}

async function forwardGitHubRequest(request, targetUrl, origin) {

  if (!isAllowedGitHubUrl(targetUrl)) {
    return createError('Forbidden: GitHub URLs only.', 403);
  }

  try {

    const reqHeaders = new Headers();

    const allowedRequestHeaders = [
      'accept',
      'accept-encoding',
      'accept-language',
      'content-type',
      'range',
      'if-none-match',
      'if-modified-since',
      'if-range',
      'user-agent',
      'git-protocol'
    ];

    for (const name of allowedRequestHeaders) {
      const value = request.headers.get(name);

      if (value) {
        reqHeaders.set(name, value);
      }
    }

    const method = request.method.toUpperCase();

    const bodyAllowed = !['GET', 'HEAD'].includes(method);

    const upstreamResp = await fetch(targetUrl.toString(), {
      method,
      headers: reqHeaders,
      body: bodyAllowed ? request.body : null,
      redirect: 'manual'
    });

    const respHeaders = corsHeaders(
      upstreamResp.headers,
      true
    );

    const location = upstreamResp.headers.get('location');

    // 处理 GitHub 重定向
    if (location) {

      let resolvedLocation;

      try {
        resolvedLocation = new URL(
          location,
          targetUrl.toString()
        );
      } catch {
        return createError('Invalid upstream redirect.', 502);
      }

      if (!isAllowedGitHubUrl(resolvedLocation)) {
        return createError(
          'Blocked: external redirect is not allowed.',
          403
        );
      }

      respHeaders.set(
        'Location',
        `${origin}${PREFIX}${resolvedLocation.toString()}`
      );
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders
    });

  } catch (error) {

    return createError(
      'Upstream request failed: ' +
      (error?.message || 'Unknown error'),
      502
    );

  }
}

// Cloudflare Pages Functions 入口
export async function onRequest(context) {

  const request = context.request;

  const url = new URL(request.url);

  // CORS 预检
  if (request.method === 'OPTIONS') {

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
          'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
        'Access-Control-Allow-Headers':
          request.headers.get(
            'Access-Control-Request-Headers'
          ) || '*',
        'Access-Control-Max-Age': '1728000'
      }
    });

  }

  // q 参数代理入口
  const queryTarget = url.searchParams.get('q');

  if (queryTarget) {

    const parsedQuery = normalizeTargetUrl(queryTarget);

    if (parsedQuery && isAllowedGitHubUrl(parsedQuery)) {

      return Response.redirect(
        `${url.origin}${PREFIX}${parsedQuery.toString()}`,
        302
      );

    }

    return createError('Invalid GitHub URL.', 400);
  }

  // 获取代理目标地址
  const rawPath = url.pathname.replace(/^\/+/, '');

  // 首页
  if (!rawPath) {

    return new Response(
      'GitHub Proxy (Cloudflare Pages) is running.',
      {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'text/plain; charset=utf-8'
        })
      }
    );

  }

  // 解析目标 URL
  const targetUrl = normalizeTargetUrl(
    rawPath,
    url.search
  );

  if (!targetUrl) {
    return createError('Bad Request: invalid URL.', 400);
  }

  // 转发请求
  return forwardGitHubRequest(
    request,
    targetUrl,
    url.origin
  );

}
