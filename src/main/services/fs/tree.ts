import { promises as fs } from 'fs'
import { join, extname } from 'path'

export interface FsTreeNode {
  path: string
  name: string
  type: 'folder' | 'docx' | 'file'
  children?: FsTreeNode[]
}

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '.aiper-recovery'])

export async function readProjectTree(rootPath: string): Promise<FsTreeNode> {
  return readNode(rootPath, rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath)
}

async function readNode(path: string, name: string): Promise<FsTreeNode> {
  const stat = await fs.stat(path)
  if (!stat.isDirectory()) {
    return { path, name, type: extname(path).toLowerCase() === '.docx' ? 'docx' : 'file' }
  }
  const entries = await fs.readdir(path, { withFileTypes: true })
  const children = await Promise.all(
    entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => readNode(join(path, e.name), e.name))
  )
  return { path, name, type: 'folder', children }
}
