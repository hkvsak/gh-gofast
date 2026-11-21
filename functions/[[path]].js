'use strict'

/**
 * hunshcn/gh-proxy
 * Cloudflare Pages Functions 适配版
 *
 * 原作者：
 * https://github.com/hunshcn/gh-proxy
 *
 * 只修改 Pages 运行入口和内部跳转地址。
 * 原有代理功能及响应头处理尽量保持不变。
 */

const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'

// 自定义路由前缀，根目录部署保持 /
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
 * Pages Functions 入口
 *
 * 原 Worker:
 * addEventListener('fetch', ...)
 *
 * Pages:
 * export async function onRequest(context)
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
 *
 * 保留原作者的 URL 提取逻辑。
 */
async function fetchHandler(req) {

    const urlStr = req.url
    const urlObj = new URL(urlStr)

    let path = urlObj.searchParams.get('q')

    // 保留原作者 q 参数功能
    if (path) {
        return Response.redirect(
            'https://' + urlObj.host + PREFIX + path,
            301
        )
    }

    /*
     * 原作者的关键逻辑：
     * Cloudflare 会把路径中的 // 合并成 /
     *
     * 这里不使用简单的 url.pathname，
     * 保留原来的 href 截取及协议恢复方式。
     */
    path = urlObj.href
        .slice(urlObj.origin.length + PREFIX.length)
        .replace(/^https?:\/+/, 'https://')


    /*
     * GitHub Releases / Archive
     * Gist
     * Tags
     * Git Clone
     */
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
 * 保留原作者请求头及请求方法处理。
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
 * 代理核心
 *
 * 原作者的代理逻辑保留。
 * 仅调整 Pages 内部跳转地址。
 */
async function proxy(urlObj, reqInit) {

    const res = await fetch(urlObj.href, reqInit)

    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    // 处理上游跳转
    if (resHdrNew.has('location')) {

        let _location = resHdrNew.get('location')

        /*
         * 相对 Location 先转换为绝对地址。
         * 避免 Pages 环境解析失败。
         */
        const nextUrl = newUrl(_location) ||
            newUrl(new URL(_location, urlObj).href)

        if (!nextUrl) {
            return makeRes('Invalid redirect URL', 502)
        }

        /*
         * GitHub 内部跳转：
         * 改成 Pages 无协议路径。
         *
         * 例如：
         * /github.com/owner/repo/releases/tag/v1
         *
         * 不生成：
         * /https://github.com/owner/repo/...
         */
        if (checkUrl(nextUrl.href)) {

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

            /*
             * 外部下载跳转：
             *
             * release-assets.githubusercontent.com
             * objects.githubusercontent.com
             *
             * 保留原作者的递归跟随逻辑。
             * 不把外部签名 URL 拼接到 Pages 地址。
             */
            reqInit.redirect = 'follow'

            return proxy(nextUrl, reqInit)
        }
    }

    /*
     * 原作者的响应头处理。
     * 不擅自删除 Content-Encoding、
     * Content-Length、Content-Disposition 等头。
     */
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

    // 原样传递响应体和其他响应头
    return new Response(res.body, {
        status,
        headers: resHdrNew
    })
}
