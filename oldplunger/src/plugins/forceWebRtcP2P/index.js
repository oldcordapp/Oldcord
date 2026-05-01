export default {
  target: 'all',
  name: 'Force WebRTC P2P',
  description:
    'Forces WebRTC p2p mode for legacy voice paths where supported by the selected build.',
  authors: ['Oldcord Team'],
  mandatory: false,
  configurable: true,
  defaultEnabled: false,
  compatibleBuilds: 'all',
  incompatiblePlugins: ['modernizeWebRTC'],
  debug: false,
  patches: [
    {
      find: '.p2p=',
      replacement: [
        {
          global: true,
          match: /.p2p=./g,
          replace: '.p2p=true',
        },
      ],
    },
  ],
};