'use strict'

/**
 * hunshcn/gh-proxy
 * Cloudflare Pages Functions 适配版
 *
 * 保留原作者代理功能：
 * Releases / Archive / Blob / Raw / Gist
 * Git Clone / Tags / jsDelivr / 白名单
 * CORS / 上游跳转 / 静态资源
 */

const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
const PREFIX = '/'

const Config = {
    jsdelivr: 0
}

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


function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'

    return new Response(body, {
        status,
        headers
    })
}


function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


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
 * Pages 专用 URL 提取
 *
 * 兼容：
 * https://github.com/...
 * https:/github.com/...
 * https%3A//github.com/...
 * github.com/...
 *
 * 这是本次修改的核心。
 */
function getProxyPath(urlObj) {

    let path = urlObj.pathname.slice(PREFIX.length)

    // 兼容协议冒号被编码
    path = path.replace(
        /^(https?)%3A/i,
        '$1:'
    )

    // 兼容协议后的斜杠被编码或被合并
    path = path.replace(
        /^(https?):(?:%2F|\/)+/i,
        '$1://'
    )

    // 保留原始查询参数
    if (urlObj.search) {
        path += urlObj.search
    }

    return path
}


/**
 * Cloudflare Pages Functions 入口
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

    const urlObj = new URL(req.url)

    let path = urlObj.searchParams.get('q')

    // 原作者 q 参数功能
    if (path) {
        return Response.redirect(
            'https://' + urlObj.host + PREFIX + path,
            301
        )
    }

    // Pages 兼容 URL 提取
    path = getProxyPath(urlObj)


    // Releases / Archive / Gist / Tags / Git Clone
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

        // 原作者静态资源
        return fetch(ASSET_URL + path)
    }
}


/**
 * HTTP 请求处理
 */
function httpHandler(req, pathname) {

    const reqHdrRaw = req.headers

    // OPTIONS 预检请求
    if (
        req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

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
 * 代理核心
 */
async function proxy(urlObj, reqInit) {

    const res = await fetch(urlObj.href, reqInit)

    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    // 上游跳转处理
    if (resHdrNew.has('location')) {

        let _location = resHdrNew.get('location')

        // 兼容相对跳转地址
        const nextUrl =
            newUrl(_location) ||
            newUrl(new URL(_location, urlObj).href)

        if (!nextUrl) {
            return makeRes('Invalid redirect URL', 502)
        }

        if (checkUrl(nextUrl.href)) {

            // GitHub 内部跳转继续走代理
            const proxyLocation =
                PREFIX +
                nextUrl.hostname +
                nextUrl.pathname +
                nextUrl.search

            resHdrNew.set(
                'location',
                proxyLocation
            )

        } else {

            // 外部下载地址跟随跳转
            reqInit.redirect = 'follow'

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

    // 原作者只删除这三个响应头
    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    return new Response(res.body, {
        status,
        headers: resHdrNew
    })
}
