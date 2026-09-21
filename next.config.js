/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fail the build on type or lint errors rather than shipping them.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  // Strip console output from production builds. `next dev` keeps it, which is
  // where the translation progress logs are actually read.
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
}

module.exports = nextConfig
