/** @type {import('next').NextConfig} */
// When building for GitHub Pages the site lives under /<repo-name>, set via NEXT_PUBLIC_BASE_PATH.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

const nextConfig = {
  // static HTML export so the app can be hosted on GitHub Pages (or any static host)
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
