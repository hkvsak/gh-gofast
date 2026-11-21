'use strict'

/**
 * hunshcn/gh-proxy
 * Cloudflare Pages Functions 适配版
 *
 * 原项目：
 * https://github.com/hunshcn/gh-proxy
 *
 * 保留原作者代理逻辑，只适配 Pages 入口和 URL 解析。
 */

const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'

// 自定义路由前缀
const PREFIX = '/'

// 分支文件使用 jsDelivr 镜像的开关
const Config = {
    jsdelivr: 0
}

// 白名单
const whiteList = []

const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods':
            'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i


/**
 * 原作者响应函数
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'

    return new Response(body, {
        status,
        headers
    })
}


/**
 * URL 解析
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


/**
 * 判断是否为支持的 GitHub URL
 */
function checkUrl(u) {
    for (let i of [
        exp1,
        exp2,
        exp3,
        exp4,
        exp5,
        exp6
    ]) {
        if (u.search(i) === 0) {
            return true
        }
    }

    return false
}


/**
 * 解析 Pages 收到的代理路径
 *
 * 支持：
 * /https://github.com/owner/repo
 * /http://github.com/owner/repo
 * /https%3A//github.com/owner/repo
 * /https%3A%2F%2Fgithub.com/owner/repo
 * /github.com/owner/repo
 *
 * 只处理协议前缀，不解码后面的路径和查询参数，
 * 避免破坏 Release 下载签名。
 */
function getProxyPath(urlObj) {

    let path = urlObj.pathname.slice(PREFIX.length)

    // 去掉 Pages 路径最前面的斜杠
    path = path.replace(/^\/+/, '')

    // 兼容冒号被编码为 %3A 的 HTTPS / HTTP
    path = path.replace(
        /^(https?)%3A(?:(?:\/|%2F)*)/i,
        'https://'
    )

    // 兼容正常协议头以及 Cloudflare 合并斜杠后的格式
    path = path.replace(
        /^https?:\/{0,2}/i,
        'https://'
    )

    // 保留目标 GitHub URL 的查询参数
    if (urlObj.search) {
        path += urlObj.search
    }

    return path
}


/**
 * Cloudflare Pages Functions 入口
 *
 * 替代原 Worker 的 addEventListener('fetch')
 */
export async function onRequest(context) {

    const req = context.request

    try {
        return await fetchHandler(req)
    } catch (err) {
        return makeRes(
            'cfworker error:\n' +
            (err.stack || err.message || String(err)),
            502
        )
    }
}


/**
 * 请求处理
 */
async function fetchHandler(req) {

    const urlStr = req.url
    const urlObj = new URL(urlStr)

    let path = urlObj.searchParams.get('q')

    // 原作者 q 参数功能
    if (path) {
        return Response.redirect(
            'https://' + urlObj.host + PREFIX + path,
            301
        )
    }

    // Pages 专用 URL 解析
    path = getProxyPath(urlObj)

    if (
        path.search(exp1) === 0 ||
        path.search(exp5) === 0 ||
        path.search(exp6) === 0 ||
        path.search(exp3) === 0
    ) {

        return httpHandler(req, path)

    } else if (path.search(exp2) === 0) {

        // Blob / Raw
        if (Config.jsdelivr) {

            const newPath = path
                .replace('/blob/', '@')
                .replace(
                    /^(?:https?:\/\/)?github\.com/,
                    'https://cdn.jsdelivr.net/gh'
                )

            return Response.redirect(newPath, 302)

        } else {

            path = path.replace('/blob/', '/raw/')

            return httpHandler(req, path)
        }

    } else if (path.search(exp4) === 0) {

        // Raw GitHub
        if (Config.jsdelivr) {

            const newPath = path
                .replace(
                    /(?<=com\/.+?\/.+?)\/(.+?\/)/,
                    '@$1'
                )
                .replace(
                    /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/,
                    'https://cdn.jsdelivr.net/gh'
                )

            return Response.redirect(newPath, 302)

        } else {

            return httpHandler(req, path)
        }

    } else {

        // 原作者静态资源处理
        return fetch(ASSET_URL + path)
    }
}


/**
 * HTTP 请求处理
 *
 * 保留原作者请求头及请求方法处理
 */
function httpHandler(req, pathname) {

    const reqHdrRaw = req.headers

    // preflight
    if (
        req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    // 原样复制请求头
    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname

    // 白名单
    let flag = !Boolean(whiteList.length)

    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }

    if (!flag) {
        return new Response('blocked', {
            status: 403
        })
    }

    // 自动补充 HTTPS
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }

    const urlObj = newUrl(urlStr)

    if (!urlObj) {
        return makeRes('Invalid URL', 400)
    }

    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }

    return proxy(urlObj, reqInit)
}


/**
 * 原作者代理核心
 */
async function proxy(urlObj, reqInit) {

    const res = await fetch(urlObj.href, reqInit)

    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    // 原作者重定向处理
    if (resHdrNew.has('location')) {

        let _location = resHdrNew.get('location')

        if (checkUrl(_location)) {

            // 保留原作者的内部 GitHub 跳转处理
            resHdrNew.set(
                'location',
                PREFIX + _location
            )

        } else {

            // 保留原作者的外部跳转跟随
            reqInit.redirect = 'follow'

            const nextUrl = newUrl(_location) ||
                newUrl(new URL(_location, urlObj).href)

            if (!nextUrl) {
                return makeRes('Invalid redirect URL', 502)
            }

            return proxy(nextUrl, reqInit)
        }
    }

    // 原作者响应头处理，完整保留
    resHdrNew.set(
        'access-control-expose-headers',
        '*'
    )

    resHdrNew.set(
        'access-control-allow-origin',
        '*'
    )

    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    // 保留原始响应体和其他响应头
    return new Response(res.body, {
        status,
        headers: resHdrNew
    })
            }
