import {downloadArticleHTML, packHTMLAssets} from './utils'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import axios from 'axios'

async function compressImage(inputPath: string) {
  try {
    // 创建临时文件路径
    const tempPath = `${inputPath}.temp`
    
    await sharp(inputPath)
      .resize(1000) // 设置最大宽度为1000px,高度自动计算保持比例
      .jpeg({ quality: 80 }) // 使用80%的JPEG质量
      .toFile(tempPath)
    
    // 删除原文件并将临时文件重命名为原文件名
    fs.unlinkSync(inputPath)
    fs.renameSync(tempPath, inputPath)
  } catch (err) {
    console.error('压缩图片失败:', err)
  }
}

async function download(link: string, title: string, dir: string) {
    try {
      // 去掉 title 中的高亮html
      const re = /<em class="highlight">(?<content>.+?)<\/em>/g
      title = title.replace(re, '$<content>')
  
      const fullHTML = await downloadArticleHTML(link)
      const outputDir = path.join(process.cwd(), 'articles', dir)
      
      // 确保输出目录存在
      fs.mkdirSync(outputDir, { recursive: true })
      
      await packHTMLAssets(fullHTML, title, outputDir)
      
      // 压缩 assets 目录下的所有图片
      const assetsDir = path.join(outputDir, 'assets')
      if (fs.existsSync(assetsDir)) {
        const files = fs.readdirSync(assetsDir)
        for (const file of files) {
          if (/\.(jpg|jpeg|png)$/i.test(file)) {
            const inputPath = path.join(assetsDir, file)
            await compressImage(inputPath)
          }
        }
      }
      
      console.log(`文件已保存并压缩到: ${outputDir}`)
    } catch (e: any) {
      console.warn(e.message)
    }
  }

interface Article {
  _id: string
  id: string
  title: string
  url: string
  authors: string[]
  aiSubCategory: string
  aiSubCategoryDesc: string
  sourceId: string
}

interface ArticleResponse {
  success: boolean
  data: {
    dataList: Article[]
    totalCount: number
  }
}

async function getArticles(sourceId: string, page: number, pageSize: number): Promise<ArticleResponse> {
  const response = await axios.get(`http://localhost:3000/api/articles`, {
    params: {
      sourceId,
      page,
      pageSize
    }
  })
  return response.data
}

async function isArticleDownloaded(dir: string): Promise<boolean> {
  const outputDir = path.join(process.cwd(), 'articles', dir)
  return fs.existsSync(path.join(outputDir, 'index.html'))
}

async function batchDownload(sourceId: string) {
  try {
    const page = 1
    const pageSize = 2000
    const response = await getArticles(sourceId, page, pageSize)
    const articles = response.data.dataList
    
    console.log(`找到 ${response.data.totalCount} 篇文章，开始下载...`)
    
    for (const article of articles) {
      const articleDir = `${article.sourceId}/${article.id}`
      if (await isArticleDownloaded(articleDir)) {
        console.log(`文章已存在，跳过下载: ${article.title}`)
        continue
      }
      
      console.log(`正在下载: ${article.title}`)
      await download(article.url, article.title, articleDir)
      // 添加延迟以避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    
    console.log('批量下载完成!')
  } catch (err) {
    console.error('批量下载失败:', err)
  }
}

// 修改调用方式
batchDownload('gh_108f2a2a27f4')