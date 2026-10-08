import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/', name: 'Cult', short_name: 'Cult', start_url: '/', display: 'standalone',
    background_color: '#000000', theme_color: '#000000',
    icons: [
      { src: '/push-icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/push-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
