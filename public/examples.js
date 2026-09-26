'use strict';

// 内置示例：每个步骤 = { seconds, url, method, topUrl, isNavigation, setCookies[] }
window.EXAMPLES = {
  full: {
    label: '完整流程',
    steps: [
      {
        seconds: 0, method: 'GET',
        url: 'https://shop.example.com/', topUrl: '', isNavigation: false,
        setCookies: [
          'sid=abc123; Domain=example.com; Path=/; Max-Age=3600',
          'cart=2; Path=/cart',
          'track=xyz; Domain=example.com; SameSite=None; Secure; Max-Age=7200'
        ]
      },
      {
        seconds: 5, method: 'GET',
        url: 'https://api.shop.example.com/v1/user',
        topUrl: 'https://shop.example.com/home', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 3600, method: 'GET',
        url: 'https://shop.example.com/', topUrl: '', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 1, method: 'POST',
        url: 'https://ads.net/track',
        topUrl: 'https://shop.example.com/home', isNavigation: false,
        setCookies: ['p=1; Path=/']
      },
      {
        seconds: 1, method: 'GET',
        url: 'https://ads.net/landing',
        topUrl: 'https://shop.example.com/home', isNavigation: true,
        setCookies: []
      },
      {
        seconds: 1, method: 'GET',
        url: 'https://shop.example.com/', topUrl: '', isNavigation: false,
        setCookies: [
          'track=v2; Domain=example.com; SameSite=None; Secure; Max-Age=7200',
          'cart=; Path=/cart; Max-Age=0'
        ]
      },
      {
        seconds: 1, method: 'GET',
        url: 'https://shop.example.com/cart', topUrl: '', isNavigation: false,
        setCookies: []
      }
    ]
  },

  samesite: {
    label: 'SameSite 三种模式',
    steps: [
      {
        seconds: 0, method: 'POST',
        url: 'https://bank.example/login', topUrl: '', isNavigation: false,
        setCookies: [
          's1=1; SameSite=Strict; Path=/',
          'l1=1; SameSite=Lax; Path=/',
          'n1=1; SameSite=None; Secure; Path=/'
        ]
      },
      {
        seconds: 2, method: 'GET',
        url: 'https://bank.example/',
        topUrl: 'https://other.example/', isNavigation: true,
        setCookies: []
      },
      {
        seconds: 2, method: 'POST',
        url: 'https://bank.example/transfer',
        topUrl: 'https://other.example/', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 2, method: 'GET',
        url: 'https://bank.example/pixel.gif',
        topUrl: 'https://other.example/', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 2, method: 'GET',
        url: 'https://bank.example/dashboard',
        topUrl: 'https://bank.example/home', isNavigation: true,
        setCookies: []
      },
      {
        seconds: 2, method: 'GET',
        url: 'https://bank.example/',
        topUrl: 'http://bank.example/', isNavigation: true,
        setCookies: []
      }
    ]
  },

  reject: {
    label: '拦截、有效期与路径',
    steps: [
      {
        seconds: 0, method: 'GET',
        url: 'https://example.com/', topUrl: '', isNavigation: false,
        setCookies: [
          'good=1; Domain=example.com; Path=/admin; Max-Age=60',
          'sec=1; Secure; Path=/',
          'k=a; Path=/',
          'k=b; Path=/x',
          'bad1=1; Domain=evil.org',
          'bad2=1; Domain=com',
          'bad3=1; SameSite=None',
          'bad4=1; Domain=co.uk',
          'gone=1; Path=/; Max-Age=0'
        ]
      },
      {
        seconds: 5, method: 'GET',
        url: 'https://example.com/admin/users', topUrl: '', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 5, method: 'GET',
        url: 'https://example.com/adminx', topUrl: '', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 5, method: 'GET',
        url: 'http://example.com/admin', topUrl: '', isNavigation: false,
        setCookies: []
      },
      {
        seconds: 60, method: 'GET',
        url: 'https://example.com/admin', topUrl: '', isNavigation: false,
        setCookies: []
      }
    ]
  }
};
