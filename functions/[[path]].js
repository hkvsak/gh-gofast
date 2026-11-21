'use strict';

/**
 * hunshcn/gh-proxy
 * Cloudflare Pages Functions 移植版
 *
 * 原项目：
 * https://github.com/hunshcn/gh-proxy
 *
 * 代理地址统一采用：
 * https://域名/github.com/owner/repo
 *
 * 不需要在路径中添加 https://
 */

// 原项目静态页面
const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/';

// Pages 部署在根路径时保持 /
const PREFIX = '/';

// 分支文件是否使用 jsDelivr
// 0 = 关闭，1 = 开启
const Config = {
  jsdelivr: 0
};

// 白名单，留空表示不限制
const whiteList = [];

// CORS 预检
const PREFLIGHT_INIT = {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':
      'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '1728000'
  }
};

// 原作者的 URL 匹配规则
const exp1 =
  /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i;

const exp2 =
  /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i;

const exp3 =
  /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i;

const exp4 =
  /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;

const exp5 =
  /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i;

const exp6 =
  /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i;


// 创建响应
function makeRes(body, status = 200, headers = {}) {
  const h = new Headers(headers);

  h.set('Access-Control-Allow-Origin', '*');

  return new Response(body, {
    status,
    headers: h
  });
}


// 解析 URL
function newUrl(urlStr) {
  try {
    return new URL(urlStr);
  } catch {
    return null;
  }
}


// 判断是否为原项目支持的 GitHub URL
function checkUrl(u) {
  if (!u) return false;

  for (const i of [
    exp1,
    exp2,
    exp3,
    exp4,
    exp5,
    exp6
  ]) {
    if (i.test(u)) {
      return true;
    }
  }

  return false;
}


// 去掉代理路径中的协议
function removeProtocol(value) {
  return value.replace(/^https?:\/\//i, '');
}


// 生成 Pages 代理地址
function makeProxyLocation(target) {
  return PREFIX +
    target.hostname +
    target.pathname +
    target.search;
}


// 解析用户输入的代理目标
function parseTarget(input) {
  if (!input) return null;

  let value = input.trim();

  // 兼容带协议和不带协议的输入
  value = value.replace(/^https?:\/\//i, '');

  return newUrl('https://' + value);
}


// Pages Functions 入口
export async function onRequest(context) {
  try {
    return await fetchHandler(context);
  } catch (err) {
    return makeRes(
      'Pages Function error:\n' +
      (err?.stack || err?.message || String(err)),
      502,
      {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    );
  }
}


// 请求入口
async function fetchHandler(context) {
  const req = context.request;
  const urlObj = new URL(req.url);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, PREFLIGHT_INIT);
  }

  // 支持 ?q= 完整 URL 输入
  const queryTarget = urlObj.searchParams.get('q');

  if (queryTarget) {
    const target = parseTarget(queryTarget);

    if (!target || !checkUrl(target.href)) {
      return makeRes('Invalid GitHub URL.', 400);
    }

    return Response.redirect(
      urlObj.origin + makeProxyLocation(target),
      302
    );
  }

  /*
   * Pages 路径解析
   *
   * 正确格式：
   * /github.com/owner/repo/releases/latest
   *
   * 不使用：
   * /https://github.com/owner/repo
   */
  let path = urlObj.pathname.slice(PREFIX.length);

  path = removeProtocol(path);

  // 保留查询参数
  if (urlObj.search) {
    path += urlObj.search;
  }

  // 根目录及非 GitHub 路径：返回原项目静态页面
  if (
    !checkUrl(path) &&
    !/^github\.com\//i.test(path) &&
    !/^raw\.(?:githubusercontent|github)\.com\//i.test(path) &&
    !/^gist\.(?:githubusercontent|github)\.com\//i.test(path)
  ) {
    return fetch(ASSET_URL + path);
  }

  // GitHub blob 转 raw
  if (exp2.test(path)) {
    if (Config.jsdelivr) {
      const newPath = path
        .replace('/blob/', '@')
        .replace(
          /^(?:https?:\/\/)?github\.com/i,
          'https://cdn.jsdelivr.net/gh'
        );

      return Response.redirect(newPath, 302);
    }

    path = path.replace('/blob/', '/raw/');

    return httpHandler(req, path);
  }

  // Raw 文件
  if (exp4.test(path) && Config.jsdelivr) {
    const newPath = path
      .replace(
        /(?<=com\/.+?\/.+?)\/(.+?\/)/,
        '@$1'
      )
      .replace(
        /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/i,
        'https://cdn.jsdelivr.net/gh'
      );

    return Response.redirect(newPath, 302);
  }

  // Releases、Archive、Tags、Git Clone、Gist、Raw
  if (checkUrl(path)) {
    return httpHandler(req, path);
  }

  return makeRes('Invalid GitHub URL.', 403);
}


// 原作者的 HTTP 代理处理逻辑
async function httpHandler(req, pathname) {
  const reqHdrRaw = req.headers;

  // CORS
  if (
    req.method === 'OPTIONS' &&
    reqHdrRaw.has('access-control-request-headers')
  ) {
    return new Response(null, PREFLIGHT_INIT);
  }

  const reqHdrNew = new Headers(reqHdrRaw);

  let urlStr = pathname;

  // 白名单检查
  let flag = !Boolean(whiteList.length);

  for (const i of whiteList) {
    if (urlStr.includes(i)) {
      flag = true;
      break;
    }
  }

  if (!flag) {
    return makeRes('blocked', 403);
  }

  // 自动补充 HTTPS
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'https://' + urlStr;
  }

  const urlObj = newUrl(urlStr);

  if (!urlObj) {
    return makeRes('Invalid URL.', 400);
  }

  const reqInit = {
    method: req.method,
    headers: reqHdrNew,
    redirect: 'manual',
    body: ['GET', 'HEAD'].includes(req.method)
      ? null
      : req.body
  };

  return proxy(urlObj, reqInit);
}


// 代理核心
async function proxy(urlObj, reqInit) {
  if (!urlObj) {
    return makeRes('Invalid upstream URL.', 502);
  }

  const res = await fetch(urlObj.href, reqInit);

  const resHdrNew = new Headers(res.headers);

  const status = res.status;

  // 处理上游跳转
  if (resHdrNew.has('location')) {
    const location = resHdrNew.get('location');

    // 支持相对跳转地址
    const nextUrl = newUrl(location) ||
      newUrl(new URL(location, urlObj).href);

    if (!nextUrl) {
      return makeRes('Invalid redirect URL.', 502);
    }

    // GitHub 内部跳转
    if (checkUrl(nextUrl.href)) {
      /*
       * 关键修改：
       * Pages 使用无协议路径。
       *
       * 例如：
       * /github.com/owner/repo/releases/tag/v1
       *
       * 不生成：
       * /https://github.com/owner/repo/releases/tag/v1
       */
      resHdrNew.set(
        'Location',
        makeProxyLocation(nextUrl)
      );
    } else {
      /*
       * 外部下载地址：
       * 例如 release-assets.githubusercontent.com
       *
       * 保留原作者的外部跳转跟随逻辑。
       * 不把外部签名 URL 拼接到 Pages 路径。
       */
      const nextInit = {
        ...reqInit,
        redirect: 'follow'
      };

      return proxy(nextUrl, nextInit);
    }
  }

  // CORS 响应头
  resHdrNew.set(
    'Access-Control-Expose-Headers',
    '*'
  );

  resHdrNew.set(
    'Access-Control-Allow-Origin',
    '*'
  );

  // 清除可能影响网页代理的安全策略
  resHdrNew.delete('content-security-policy');
  resHdrNew.delete('content-security-policy-report-only');
  resHdrNew.delete('clear-site-data');

  // 删除逐跳传输头
  resHdrNew.delete('connection');
  resHdrNew.delete('keep-alive');
  resHdrNew.delete('transfer-encoding');
  resHdrNew.delete('upgrade');

  /*
   * 直接传递文件流。
   * 不读取 APK 到内存。
   * 保留 Content-Disposition、Content-Type、Range 等响应头。
   */
  return new Response(res.body, {
    status,
    headers: resHdrNew
  });
}
