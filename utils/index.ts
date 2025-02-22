import dayjs from "dayjs";
import mime from "mime";
import {sleep} from "@antfu/utils";
import * as pool from './pool';
import type {DownloadableArticle} from "../types";
import type {AudioResource, VideoPageInfo} from "../types";
import fetch from 'node-fetch'
import { JSDOM } from 'jsdom'
import path from 'path';
import fs from 'fs';


export function formatTimeStamp(timestamp: number) {
    return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
}

export function formatItemShowType(type: number) {
    switch (type) {
        case 0:
            return '普通图文'
        case 5:
            return '视频分享'
        case 6:
            return '音乐分享'
        case 7:
            return '音频分享'
        case 8:
            return '图片分享'
        case 10:
            return '文本分享'
        case 11:
            return '文章分享'
        case 17:
            return '短文'
        default:
            return '未识别'
    }
}

// 将 $fetch 替换为 fetch
async function $fetch<T extends string | Buffer>(url: string, options?: any): Promise<T & { contentType?: string }> {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }
  
  const contentType = response.headers.get('content-type')
  
  if (contentType && (contentType.includes('text') || contentType.includes('html'))) {
    const text = await response.text()
    return text as T & { contentType?: string }
  } else {
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    ;(buffer as any).contentType = contentType
    return buffer as unknown as T & { contentType?: string }
  }
}

/**
 * 使用代理下载资源
 * @param url 资源地址
 * @param proxy 代理地址
 * @param withCredential
 * @param timeout 超时时间(单位: 秒)，默认 30
 */
async function downloadAssetWithProxy<T extends Buffer | string>(url: string, proxy: string | undefined, withCredential = false, timeout = 30) {
    const headers: Record<string, string> = {}
    // 在 Node 环境中不需要处理 credentials
    let targetURL = proxy ? `${proxy}?url=${encodeURIComponent(url)}&headers=${encodeURIComponent(JSON.stringify(headers))}` : url
    targetURL = targetURL.replace(/^http:\/\//, 'https://')

    return await $fetch<T>(targetURL, {
        retry: 0,
        timeout: timeout * 1000,
    })
}


/**
 * 下载文章的 html
 * @param articleURL
 * @param title
 */
export async function downloadArticleHTML(articleURL: string, title?: string) {
    let html = ''
    const dom = new JSDOM()
    const parser = new dom.window.DOMParser()

    const htmlDownloadFn = async (url: string, proxy: string) => {
        const fullHTML = await downloadAssetWithProxy<string>(url, proxy, true)

        const document = parser.parseFromString(fullHTML, 'text/html')
        const $jsContent = document.querySelector('#js_content')
        const $layout = document.querySelector('#js_fullscreen_layout_padding')
        if (!$jsContent) {
            if ($layout) {
                console.log(`文章(${title})已被删除，跳过下载`)
                return 0
            }

            console.log(`文章(${title})下载失败`)
            throw new Error('下载失败，请重试')
        }
        html = fullHTML

        return Buffer.from(html).length // 替代 Blob
    }

    await pool.downloads([articleURL], htmlDownloadFn)

    if (!html) {
        throw new Error('下载html失败，请稍后重试')
    }

    return html
}

/**
 * 批量下载文章 html
 * @param articles
 * @param callback
 */
export async function downloadArticleHTMLs(articles: DownloadableArticle[], callback: (count: number) => void) {
    const results: DownloadableArticle[] = []

    const htmlDownloadFn = async (article: DownloadableArticle, proxy: string) => {
        const fullHTML = await downloadAssetWithProxy<string>(article.url, proxy, true)
        const dom = new JSDOM(fullHTML)
        const document = dom.window.document

        const $jsContent = document.querySelector('#js_content')
        const $layout = document.querySelector('#js_fullscreen_layout_padding')
        if (!$jsContent) {
            if ($layout) {
                console.log(`文章(${article.title})已被删除，跳过下载`)
                return 0
            }

            console.log(`文章(${article.title})下载失败`)
            throw new Error('下载失败，请重试')
        }

        article.html = fullHTML
        results.push(article)
        callback(results.length)
        await sleep(2000)

        return Buffer.from(fullHTML).length
    }

    await pool.downloads(articles, htmlDownloadFn)

    return results
}


/**
 * 打包 html 中的资源
 * @param html
 * @param title
 * @param outputDir
 */
export async function packHTMLAssets(html: string, title: string, outputDir: string) {
    // 创建 assets 目录
    const assetsDir = path.join(outputDir, 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })

    // 修改所有的资源下载函数，将 zip.file 改为 fs.writeFileSync
    const resourceDownloadFn = async (url: string, proxy: string) => {
        const data = await downloadAssetWithProxy<Buffer>(url, proxy, false, 10)
        const uuid = new Date().getTime() + Math.random().toString()
        const ext = mime.getExtension(data.contentType || 'application/octet-stream')
        const filename = `${uuid}.${ext}`
        
        fs.writeFileSync(path.join(assetsDir, filename), data)
        return `./assets/${filename}`
    }

    const dom = new JSDOM(html)
    const { document, window } = dom.window
    
    // 替换所有 window 引用
    const parser = new dom.window.DOMParser()
    const $jsArticleContent = document.querySelector('#js_article')!
    const $jsArticleBottomBar = document.querySelector('#js_article_bottom_bar')!

    // #js_content 默认是不可见的(通过js修改为可见)，需要移除该样式
    $jsArticleContent.querySelector('#js_content')?.removeAttribute('style')

    // 删除无用dom元素
    $jsArticleContent.querySelector('#js_top_ad_area')?.remove()
    $jsArticleContent.querySelector('#js_tags_preview_toast')?.remove()
    $jsArticleContent.querySelector('#content_bottom_area')?.remove()
    $jsArticleContent.querySelectorAll('script').forEach((el: Element) => {
        el.remove()
    })
    $jsArticleContent.querySelector('#js_pc_qr_code')?.remove()
    $jsArticleContent.querySelector('#wx_stream_article_slide_tip')?.remove()


    let bodyCls = document.body.className

    // 渲染发布时间
    function __setPubTime(oriTimestamp: number, dom: HTMLElement) {
        const dateObj = new Date(oriTimestamp * 1000);
        const padStart = function padStart(v: number) {
            return "0".concat(v.toString()).slice(-2);
        };
        const year = dateObj.getFullYear().toString();
        const month = padStart(dateObj.getMonth() + 1);
        const date = padStart(dateObj.getDate());
        const hour = padStart(dateObj.getHours());
        const minute = padStart(dateObj.getMinutes());
        const timeString = "".concat(hour, ":").concat(minute);
        const dateString = "".concat(year, "年").concat(month, "月").concat(date, "日");
        const showDate = "".concat(dateString, " ").concat(timeString);

        if (dom) {
            dom.textContent = showDate;
        }
    }
    const pubTimeMatchResult = html.match(/var oriCreateTime = '(?<date>\d+)'/)
    if (pubTimeMatchResult && pubTimeMatchResult.groups && pubTimeMatchResult.groups.date) {
        __setPubTime(parseInt(pubTimeMatchResult.groups.date), document.getElementById('publish_time')!)
    }

    // 渲染ip属地
    function getIpWoridng(ipConfig: any) {
        let ipWording = '';
        if (parseInt(ipConfig.countryId, 10) === 156) {
            ipWording = ipConfig.provinceName;
        } else if (ipConfig.countryId) {
            ipWording = ipConfig.countryName;
        }
        return ipWording;
    }
    const ipWrp = document.getElementById('js_ip_wording_wrp')!
    const ipWording = document.getElementById('js_ip_wording')!
    const ipWordingMatchResult = html.match(/window\.ip_wording = (?<data>{\s+countryName: '[^']+',[^}]+})/s)
    if (ipWrp && ipWording && ipWordingMatchResult && ipWordingMatchResult.groups && ipWordingMatchResult.groups.data) {
        const json = ipWordingMatchResult.groups.data
        eval('window.ip_wording = ' + json)
        const ipWordingDisplay = getIpWoridng((window as any).ip_wording)
        if (ipWordingDisplay !== '') {
            ipWording.innerHTML = ipWordingDisplay;
            ipWrp.style.display = 'inline-block';
        }
    }

    // 渲染 标题已修改
    function __setTitleModify(isTitleModified: boolean) {
        const wrp = document.getElementById('js_title_modify_wrp')!
        const titleModifyNode = document.getElementById('js_title_modify')!
        if (!wrp) return;
        if (isTitleModified) {
            titleModifyNode.innerHTML = '标题已修改';
            wrp.style.display = 'inline-block';
        } else {
            wrp.parentNode?.removeChild(wrp);
        }
    }
    const titleModifiedMatchResult = html.match(/window\.isTitleModified = "(?<data>\d*)" \* 1;/)
    if (titleModifiedMatchResult && titleModifiedMatchResult.groups && titleModifiedMatchResult.groups.data) {
        __setTitleModify(titleModifiedMatchResult.groups.data === '1')
    }

    // 文章引用
    const js_share_source = document.getElementById('js_share_source')
    const contentTpl = document.getElementById('content_tpl')
    if (js_share_source && contentTpl) {
        const html = contentTpl.innerHTML
            .replace(/<img[^>]*>/g, '<p>[图片]</p>')
            .replace(/<iframe [^>]*?class=\"res_iframe card_iframe js_editor_card\"[^>]*?data-cardid=[\'\"][^\'\"]*[^>]*?><\/iframe>/ig, '<p>[卡券]</p>')
            .replace(/<mpvoice([^>]*?)js_editor_audio([^>]*?)><\/mpvoice>/g, '<p>[语音]</p>')
            .replace(/<mpgongyi([^>]*?)js_editor_gy([^>]*?)><\/mpgongyi>/g, '<p>[公益]</p>')
            .replace(/<qqmusic([^>]*?)js_editor_qqmusic([^>]*?)><\/qqmusic>/g, '<p>[音乐]</p>')
            .replace(/<mpshop([^>]*?)js_editor_shop([^>]*?)><\/mpshop>/g, '<p>[小店]</p>')
            .replace(/<iframe([^>]*?)class=[\'\"][^\'\"]*video_iframe([^>]*?)><\/iframe>/g, '<p>[视频]</p>')
            .replace(/(<iframe[^>]*?js_editor_vote_card[^<]*?<\/iframe>)/gi, '<p>[投票]</p>')
            .replace(/<mp-weapp([^>]*?)weapp_element([^>]*?)><\/mp-weapp>/g, '<p>[小程序]</p>')
            .replace(/<mp-miniprogram([^>]*?)><\/mp-miniprogram>/g, '<p>[小程序]</p>')
            .replace(/<mpproduct([^>]*?)><\/mpproduct>/g, '<p>[商品]</p>')
            .replace(/<mpcps([^>]*?)><\/mpcps>/g, '<p>[商品]</p>');
        const div = document.createElement('div');
        div.innerHTML = html;
        let content = div.innerText;
        content = content.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
        if (content.length > 140) {
            content = content.substr(0, 140) + '...';
        }
        const digest = content.split('\n').map(function(line) {
            return '<p>' + line + '</p>';
        })
        document.getElementById('js_content')!.innerHTML = digest.join('');

        // 替换url
        const sourceURL = js_share_source.getAttribute('data-url')
        if (sourceURL) {
            const link = document.createElement('a')
            link.href = sourceURL
            link.className = js_share_source.className
            link.innerHTML = js_share_source.innerHTML
            js_share_source.replaceWith(link)
        }
    }

    const $js_image_desc = $jsArticleContent.querySelector('#js_image_desc')
    // 图片分享消息
    if ($js_image_desc) {
        bodyCls += 'pages_skin_pc page_share_img'

        function decode_html(data: string, encode: boolean) {
            const replace = ["&#39;", "'", "&quot;", '"', "&nbsp;", " ", "&gt;", ">", "&lt;", "<", "&yen;", "¥", "&amp;", "&"];
            const replaceReverse = ["&", "&amp;", "¥", "&yen;", "<", "&lt;", ">", "&gt;", " ", "&nbsp;", '"', "&quot;", "'", "&#39;"];

            let target = encode ? replaceReverse : replace
            let str = data
            for (let i = 0; i < target.length; i += 2) {
                str = str.replace(new RegExp(target[i], 'g'), target[i + 1])
            }
            return str
        }

        const qmtplMatchResult = html.match(/(?<code>window\.__QMTPL_SSR_DATA__\s*=\s*\{.+?)<\/script>/s)
        if (qmtplMatchResult && qmtplMatchResult.groups && qmtplMatchResult.groups.code) {
            const code = qmtplMatchResult.groups.code
            eval(code)
            const data = (window as any).__QMTPL_SSR_DATA__
            let desc = data.desc.replace(/\r/g, '').replace(/\n/g, '<br>').replace(/\s/g, '&nbsp;')
            desc = decode_html(desc, false)
            $js_image_desc.innerHTML = desc

            $jsArticleContent.querySelector('#js_top_profile')!.classList.remove('profile_area_hide')
        }
        const pictureMatchResult = html.match(/(?<code>window\.picture_page_info_list\s*=.+\.slice\(0,\s*20\);)/s)
        if (pictureMatchResult && pictureMatchResult.groups && pictureMatchResult.groups.code) {
            const code = pictureMatchResult.groups.code
            eval(code)
            const picture_page_info_list = (window as any).picture_page_info_list
            const containerEl = $jsArticleContent.querySelector('#js_share_content_page_hd')!
            let innerHTML = '<div style="display: flex;flex-direction: column;align-items: center;gap: 10px;padding-block: 20px;">'
            for (const picture of picture_page_info_list) {
                innerHTML += `<img src="${picture.cdn_url}" alt="" style="display: block;border: 1px solid gray;border-radius: 5px;max-width: 90%;" onclick="window.open(this.src, '_blank', 'popup')" />`
            }
            innerHTML += '</div>'
            containerEl.innerHTML = innerHTML
        }
    }

    // 视频分享消息
    const $js_common_share_desc = $jsArticleContent.querySelector('#js_common_share_desc')
    if ($js_common_share_desc) {
        // 分享视频摘要
        bodyCls += 'zh_CN wx_wap_page wx_wap_desktop_fontsize_2 page_share_video white_video_page discuss_tab appmsg_skin_default appmsg_style_default pages_skin_pc'
        const videoContentMatchResult = html.match(/(?<code>var\s+videoContentNoEncode\s*=\s*window\.a_value_which_never_exists\s*\|\|\s*(?<value>'[^']+'))/s)
        if (videoContentMatchResult && videoContentMatchResult.groups && videoContentMatchResult.groups.value) {
            const code = 'window.videoContentNoEncode = ' + videoContentMatchResult.groups.value
            eval(code)
            let desc = (window as any).videoContentNoEncode
            desc = desc.replace(/\r/g, '').replace(/\n/g, '<br>')
            $js_common_share_desc.innerHTML = desc
        }
    }
    const $js_mpvedio = $jsArticleContent.querySelector('.js_video_channel_container > #js_mpvedio')
    if ($js_mpvedio) {
        // 分享视频
        // poster
        let poster = ''
        const mpVideoCoverUrlMatchResult = html.match(/(?<code>window\.__mpVideoCoverUrl\s*=\s*'[^']*';)/s)
        if (mpVideoCoverUrlMatchResult && mpVideoCoverUrlMatchResult.groups && mpVideoCoverUrlMatchResult.groups.code) {
            const code = mpVideoCoverUrlMatchResult.groups.code
            eval(code)
            poster = (window as any).__mpVideoCoverUrl
        }

        // video info
        let videoUrl = ''
        const mpVideoTransInfoMatchResult = html.match(/(?<code>window\.__mpVideoTransInfo\s*=\s*\[.+?];)/s)
        if (mpVideoTransInfoMatchResult && mpVideoTransInfoMatchResult.groups && mpVideoTransInfoMatchResult.groups.code) {
            const code = mpVideoTransInfoMatchResult.groups.code
            eval(code)
            const mpVideoTransInfo = (window as any).__mpVideoTransInfo
            if (Array.isArray(mpVideoTransInfo) && mpVideoTransInfo.length > 0) {
                mpVideoTransInfo.forEach((trans: any) => {
                    trans.url = trans.url.replace(/&amp;/g, '&')
                })

                // 这里为了节省流量需要控制清晰度
                videoUrl = mpVideoTransInfo[mpVideoTransInfo.length - 1].url

                // 下载资源
                const videoURLMap = new Map<string, string>()
                const resourceDownloadFn = async (url: string, proxy: string) => {
                    const videoData = await downloadAssetWithProxy<Buffer>(url, proxy, false,10)
                    const uuid = new Date().getTime() + Math.random().toString()
                    const ext = mime.getExtension(videoData.contentType || 'application/octet-stream')
                    const filename = `${uuid}.${ext}`
                    
                    fs.writeFileSync(path.join(assetsDir, filename), videoData)
                    videoURLMap.set(url, `./assets/${filename}`)
                    return videoData.length
                }

                const urls: string[] = []
                if (poster) {
                    urls.push(poster)
                }
                urls.push(videoUrl)
                await pool.downloads<string>(urls, resourceDownloadFn)

                const div = document.createElement('div')
                div.style.cssText = 'height: 381px;background: #000;border-radius: 4px; overflow: hidden;margin-bottom: 12px;'
                div.innerHTML = `<video src="${videoURLMap.get(videoUrl)}" poster="${videoURLMap.get(poster)}" controls style="width: 100%;height: 100%;"></video>`
                $js_mpvedio.appendChild(div)
            }
        }
    }

    // 下载内嵌音频
    const mpAudioEls = $jsArticleContent.querySelectorAll<HTMLElement>('mp-common-mpaudio')
    if (mpAudioEls.length > 0) {
        const audioResourceDownloadFn = async (asset: AudioResource, proxy: string) => {
            const audioData = await downloadAssetWithProxy<Buffer>(asset.url, proxy, false, 10)
            const uuid = asset.uuid
            const ext = mime.getExtension(audioData.contentType || 'application/octet-stream')
            const filename = `${uuid}.${ext}`
            
            fs.writeFileSync(path.join(assetsDir, filename), audioData)

            let targetEl: HTMLElement | null = null
            mpAudioEls.forEach(el => {
                const id = el.getAttribute('data-uuid')
                if (id === uuid) {
                    targetEl = el
                }
            })
            if (!targetEl) {
                throw new Error('下载失败')
            }

            if (asset.type === 'cover') {
                (targetEl as HTMLElement).setAttribute('cover', `./assets/${filename}`)
            } else if (asset.type === 'audio') {
                (targetEl as HTMLElement).setAttribute('src', `./assets/${filename}`)
            }

            return audioData.length
        }

        const assets: AudioResource[] = []
        mpAudioEls.forEach(mpAudioEl => {
            const uuid = new Date().getTime() + Math.random().toString()
            mpAudioEl.setAttribute('data-uuid', uuid)
            const cover = mpAudioEl.getAttribute('cover')!
            const voice_encode_fileid = mpAudioEl.getAttribute('voice_encode_fileid')!
            assets.push({
                uuid: uuid,
                type: 'cover',
                url: cover,
            })
            assets.push({
                uuid: uuid,
                type: 'audio',
                url: 'https://res.wx.qq.com/voice/getvoice?mediaid=' + voice_encode_fileid,
            })
        })

        await pool.downloads<AudioResource>(assets, audioResourceDownloadFn)
    }

    // 下载内嵌视频
    const videoPageInfosMatchResult = html.match(/(?<code>var videoPageInfos = \[.+?window.__videoPageInfos = videoPageInfos;)/s)
    if (videoPageInfosMatchResult && videoPageInfosMatchResult.groups && videoPageInfosMatchResult.groups.code) {
        const code = videoPageInfosMatchResult.groups.code
        eval(code)
        const videoPageInfos: VideoPageInfo[] = (window as any).__videoPageInfos
        videoPageInfos.forEach(videoPageInfo => {
            videoPageInfo.mp_video_trans_info.forEach(trans => {
                trans.url = trans.url.replace(/&amp;/g, '&')
            })
        })

        // 下载资源
        const videoURLMap = new Map<string, string>()
        const resourceDownloadFn = async (url: string, proxy: string) => {
            const videoData = await downloadAssetWithProxy<Buffer>(url, proxy, false,10)
            const uuid = new Date().getTime() + Math.random().toString()
            const ext = mime.getExtension(videoData.contentType || 'application/octet-stream')
            const filename = `${uuid}.${ext}`
            
            fs.writeFileSync(path.join(assetsDir, filename), videoData)
            videoURLMap.set(url, `./assets/${filename}`)
            return videoData.length
        }

        const urls: string[] = []
        videoPageInfos.forEach(videoPageInfo => {
            if (videoPageInfo.cover_url) {
                urls.push(videoPageInfo.cover_url)
            }
            if (videoPageInfo.is_mp_video === 1 && videoPageInfo.mp_video_trans_info.length > 0) {
                urls.push(videoPageInfo.mp_video_trans_info[0].url)
            }
        })
        await pool.downloads<string>(urls, resourceDownloadFn)

        const videoIframes = $jsArticleContent.querySelectorAll('iframe.video_iframe')
        videoIframes.forEach(videoIframe => {
            const mpvid = videoIframe.getAttribute('data-mpvid')
            if (mpvid) {
                const videoInfo = videoPageInfos.find(info => info.video_id === mpvid)
                if (videoInfo) {
                    const div = document.createElement('div')
                    div.style.cssText = 'height: 508px;background: #000;border-radius: 4px; overflow: hidden;margin-bottom: 12px;'
                    div.innerHTML = `<video src="${videoURLMap.get(videoInfo.mp_video_trans_info[0]?.url)}" poster="${videoURLMap.get(videoInfo.cover_url)}" controls style="width: 100%;height: 100%;"></video>`
                    videoIframe.replaceWith(div)
                }
            } else {
                const src = videoIframe.getAttribute('data-src')!
                const vidMatchResult = src.match(/v\.qq\.com\/iframe\/preview\.html\?vid=(?<vid>[\da-z]+)/i)
                if (vidMatchResult && vidMatchResult.groups && vidMatchResult.groups.vid) {
                    const vid = vidMatchResult.groups.vid
                    videoIframe.setAttribute('src', 'https://v.qq.com/txp/iframe/player.html?vid=' + vid)
                    videoIframe.setAttribute('width', '100%')
                }
            }
        })
    }


    // 下载所有的图片
    const imgDownloadFn = async (img: Element, proxy: string) => {
        const url = img.getAttribute('src') || img.getAttribute('data-src')
        if (!url) {
            return 0
        }

        const imgData = await downloadAssetWithProxy<Buffer>(url, proxy, false, 10)
        const uuid = new Date().getTime() + Math.random().toString()
        const ext = mime.getExtension(imgData.contentType || 'application/octet-stream')
        const filename = `${uuid}.${ext}`
        
        fs.writeFileSync(path.join(assetsDir, filename), imgData)

        img.setAttribute('src', `./assets/${filename}`)

        return imgData.length
    }
    const imgs = Array.from($jsArticleContent.querySelectorAll('img')) as Element[]
    if (imgs.length > 0) {
        await pool.downloads<any>(imgs, imgDownloadFn)
    }


    // 下载背景图片 背景图片无法用选择器选中并修改，因此用正则进行匹配替换
    let pageContentHTML = $jsArticleContent.outerHTML
    const jsArticleBottomBarHTML = $jsArticleBottomBar?.outerHTML

    // 收集所有的背景图片地址
    const bgImageURLs = new Set<string>()
    pageContentHTML = pageContentHTML.replaceAll(
        /((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs,
        (match: string, p1: string, url: string, p3: string) => {
            bgImageURLs.add(url)
            return `${p1}${url}${p3}`
        }
    )
    if (bgImageURLs.size > 0) {
        // 下载背景图片
        const bgImgDownloadFn = async (url: string, proxy: string) => {
            const imgData = await downloadAssetWithProxy<Buffer>(url, proxy, false,10)
            const uuid = new Date().getTime() + Math.random().toString()
            const ext = mime.getExtension(imgData.contentType || 'application/octet-stream')
            const filename = `${uuid}.${ext}`
            
            fs.writeFileSync(path.join(assetsDir, filename), imgData)
            return imgData.length
        }

        await pool.downloads<string>([...bgImageURLs], bgImgDownloadFn)

        // 替换背景图片路径
        pageContentHTML = pageContentHTML.replaceAll(
            /((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs,
            (match: string, p1: string, url: string, p3: string) => {
                if (bgImageURLs.has(url)) {
                    return `${p1}${url}${p3}`
                }
                console.warn('背景图片丢失: ', url)
                return `${p1}${url}${p3}`
            }
        )
    }

    const indexHTML = `<!DOCTYPE html>
<html lang="zh_CN">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=0,viewport-fit=cover">
    <title>${title}</title>
    <link rel="stylesheet" href="/assets/css/1.css">
    <link rel="stylesheet" href="/assets/css/2.css">
    <link rel="stylesheet" href="/assets/css/3.css">
    <link rel="stylesheet" href="/assets/css/4.css">
    <link rel="stylesheet" href="/assets/css/5.css">
    <link rel="stylesheet" href="/assets/css/6.css">
    <style>
        #page-content,
        #js_article_bottom_bar,
        .__page_content__ {
            max-width: 760px;
            margin: 0 auto;
        }
        img {
            max-width: 100%;
        }
        .sns_opr_btn::before {
            width: 16px;
            height: 16px;
            margin-right: 3px;
        }
    </style>
</head>
<body class="${bodyCls}">

${pageContentHTML}
${jsArticleBottomBarHTML}
</body>
</html>`

    fs.writeFileSync(path.join(outputDir, 'index.html'), indexHTML)
}
