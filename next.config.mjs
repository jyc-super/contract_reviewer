/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Required to enable instrumentation.ts (Next.js 14 instrumentation hook).
  experimental: {
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    // pdfjs-dist: canvas and encoding are not needed in Node.js text extraction
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;

    // sidecar-manager.ts uses Node.js built-ins (child_process, path, fs).
    // Although instrumentation.ts imports it dynamically, webpack still
    // statically analyzes the module graph.  Mark these as external so webpack
    // does not attempt to bundle them for server bundles.
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        "child_process",
        "fs",
        "path",
      ];
    }

    return config;
  },
};

export default nextConfig;
