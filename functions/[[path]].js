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

// GitHub URL 路径白名单
const GITHUB_PATH_PATTERNS = [
  /^\/[^/]+\/[^/]+\/(?:releases|archive)\/.+/i,
  /^\/[^/]+\/[^/]+\/(?:blob|raw)\/.+/i,
  /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/i,
  /^\/[^/]+\/[^/]+\/tags(?:\/.*)?$/i
];

// 检查 GitHub 地址是否合法
function isAllowedGitHubUrl(url) {

  if (!url || url.protocol !== 'https:') {
    return false;
  }

  if (url.username || url.password) {
    return false;
  }

  if (url.port && url.port !== '443') {
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

  if (host === 'codeload.github.com') {
    return /^\/[^/]+\/[^/]+\/.+/i.test(path);
  }

  if (
    host === 'objects.githubusercontent.com' ||
    host === 'release-assets.githubusercontent.com'
  ) {
    return true;
  }

  return false;
}


// URL 标准化
function normalizeTargetUrl(rawInput, search = '') {

  if (!rawInput) {
    return null;
  }

  let normalized = rawInput.trim();

  // 修复协议斜杠被合并的问题
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


// CORS 响应头
function withCorsHeaders(headers, exposeAll = false) {

  const out = new Headers(headers);

  out.set('Access-Control-Allow-Origin', '*');

  if (exposeAll) {
    out.set('Access-Control-Expose-Headers', '*');
  }

  out.delete('Content-Security-Policy');
  out.delete('Content-Security-Policy-Report-Only');
  out.delete('Clear-Site-Data');

  return out;
}


// 错误响应
function errorResponse(message, status = 502) {

  return new Response(message, {

    status,

    headers: withCorsHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })

  });

}


// 过滤请求头
function prepareRequestHeaders(request) {

  const headers = new Headers();

  const allowedHeaders = [

    'accept',
    'accept-language',
    'authorization',
    'content-type',
    'range',
    'if-none-match',
    'if-modified-since',
    'if-range',
    'if-match',
    'if-unmodified-since',
    'user-agent',
    'git-protocol'

  ];

  for (const name of allowedHeaders) {

    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }

  }

  return headers;

}


// 处理 GitHub 请求
async function forwardGitHubRequest(
  request,
  targetUrl,
  origin
) {

  if (!isAllowedGitHubUrl(targetUrl)) {

    return errorResponse(
      'Forbidden: GitHub URLs only.',
      403
    );

  }

  try {

    const method = request.method.toUpperCase();

    const bodyAllowed = ![
      'GET',
      'HEAD'
    ].includes(method);

    const reqHeaders = prepareRequestHeaders(request);

    // 请求 GitHub 上游
    const upstreamResp = await fetch(
      targetUrl.toString(),
      {

        method,

        headers: reqHeaders,

        body: bodyAllowed
          ? request.body
          : null,

        redirect: 'manual'

      }
    );

    const respHeaders = withCorsHeaders(
      upstreamResp.headers,
      true
    );

    // 过滤逐跳响应头
    const hopByHopHeaders = [
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade'
    ];

    for (const name of hopByHopHeaders) {
      respHeaders.delete(name);
    }

    // 处理 GitHub 重定向
    const location = upstreamResp.headers.get('location');

    if (location) {

      let resolvedLocation;

      try {

        resolvedLocation = new URL(
          location,
          targetUrl.toString()
        );

      } catch {

        return errorResponse(
          'Invalid upstream redirect.',
          502
        );

      }

      // 只允许白名单域名之间跳转
      if (!isAllowedGitHubUrl(resolvedLocation)) {

        return errorResponse(
          'Blocked external redirect: ' +
          resolvedLocation.hostname,
          403
        );

      }

      // 将上游跳转转换为代理地址
      respHeaders.set(
        'Location',
        origin +
        PREFIX +
        resolvedLocation.toString()
      );

    }

    // 流式返回上游响应
    return new Response(
      upstreamResp.body,
      {

        status: upstreamResp.status,

        statusText: upstreamResp.statusText,

        headers: respHeaders

      }
    );

  } catch (error) {

    return errorResponse(
      'GitHub upstream error: ' +
      (error?.message || String(error)),
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


  // q 参数兼容
  const queryTarget = url.searchParams.get('q');

  if (queryTarget) {

    const parsedQuery = normalizeTargetUrl(
      queryTarget
    );

    if (
      parsedQuery &&
      isAllowedGitHubUrl(parsedQuery)
    ) {

      return Response.redirect(
        url.origin +
        PREFIX +
        parsedQuery.toString(),
        302
      );

    }

    return errorResponse(
      'Invalid GitHub URL.',
      400
    );

  }


  // 获取原始代理路径
  // 不依赖 context.params，避免动态路由解码差异
  const rawPath = url.pathname.replace(/^\/+/, '');


  // 首页
  if (!rawPath) {

    return new Response(
      'GitHub Proxy (Cloudflare Pages) is running.',
      {

        status: 200,

        headers: withCorsHeaders({

          'Content-Type':
            'text/plain; charset=utf-8'

        })

      }
    );

  }


  // 解析目标地址
  const targetUrl = normalizeTargetUrl(
    rawPath,
    url.search
  );


  if (!targetUrl) {

    return errorResponse(
      'Bad Request: invalid target URL.',
      400
    );

  }


  // 执行代理
  return forwardGitHubRequest(
    request,
    targetUrl,
    url.origin
  );

}
