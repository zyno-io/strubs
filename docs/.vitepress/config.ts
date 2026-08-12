import { defineConfig } from 'vitepress'

// The base path. GitHub project Pages serve at https://<org>.github.io/<repo>/, so the default is `/strubs/`.
// Override with DOCS_BASE=/ for a user/org page or a custom domain (the deploy workflow sets it).
const base = process.env.DOCS_BASE ?? '/strubs/'

export default defineConfig({
  title: 'STRUBS',
  description:
    'Striping & Redundancy Using Basic Disks — a single-host, fault-tolerant object store built on Reed–Solomon erasure coding across ordinary disks with ordinary filesystems.',
  base,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,

  head: [
    ['meta', { name: 'theme-color', content: '#3c8772' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'STRUBS Documentation' }],
    ['meta', {
      property: 'og:description',
      content: 'Single-host, fault-tolerant object store on Reed–Solomon erasure coding. No RAID controller, no volume manager, no single thing whose failure loses everything.'
    }]
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/architecture', activeMatch: '/(architecture|data-integrity|on-disk-format)' },
      {
        text: 'Operations',
        activeMatch: '/(operations|encryption|access-control|configuration)',
        items: [
          { text: 'Running STRUBS', link: '/operations' },
          { text: 'Encryption (LUKS)', link: '/encryption' },
          { text: 'Access control', link: '/access-control' },
          { text: 'Configuration', link: '/configuration' }
        ]
      },
      { text: 'API', link: '/api' },
      { text: 'Contributing', link: '/development' }
    ],

    sidebar: [
      {
        text: 'Introduction',
        collapsed: false,
        items: [{ text: 'What STRUBS is', link: '/' }]
      },
      {
        text: 'How it works',
        collapsed: false,
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Data integrity', link: '/data-integrity' },
          { text: 'On-disk format', link: '/on-disk-format' }
        ]
      },
      {
        text: 'Operations',
        collapsed: false,
        items: [
          { text: 'Running STRUBS', link: '/operations' },
          { text: 'Encryption (LUKS)', link: '/encryption' },
          { text: 'Access control', link: '/access-control' },
          { text: 'Configuration', link: '/configuration' }
        ]
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [{ text: 'HTTP API', link: '/api' }]
      },
      {
        text: 'Contributing',
        collapsed: false,
        items: [{ text: 'Development', link: '/development' }]
      }
    ],

    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: 'https://github.com/signal24/strubs' }],

    editLink: {
      pattern: 'https://github.com/signal24/strubs/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: { prev: 'Previous', next: 'Next' },

    footer: {
      message: 'AGPL-3.0-only. In production since 2017.',
      copyright: 'STRUBS — Striping & Redundancy Using Basic Disks'
    }
  }
})
