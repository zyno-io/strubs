import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  base: mode === 'production' ? '/$/ui/' : '/',
  server: {
    proxy: {
      '/$/': {
        target: 'http://10.24.0.12:80',
        changeOrigin: true,
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@strubs': path.resolve(__dirname, '../lib')
    }
  }
}))
