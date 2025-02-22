import {downloadArticleHTML, packHTMLAssets} from './utils'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

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

async function download(link: string, title: string) {
    try {
      // 去掉 title 中的高亮html
      const re = /<em class="highlight">(?<content>.+?)<\/em>/g
      title = title.replace(re, '$<content>')
  
      const fullHTML = await downloadArticleHTML(link)
      const outputDir = path.join(process.cwd(), 'downloads', title)
      
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

  download('https://mp.weixin.qq.com/s/9TV33uWZ7BuqAOmMOBMf3A', '898')