const dgram = require('dgram');
const exec = require('child_process').exec;
const client = dgram.createSocket('udp4');
const version = require('./package.json').version;
const db = require('./db');
const http = require('http');

let gateway = '172.16.0.1';
let managerConfig = '0.0.0.0:6002';
let interface = 'tun0';
const argv = process.argv.filter((ele, index) => index > 1);
const toMib=(p1, meter)=> {
    switch (meter) {
        case 'KiB':
            return p1 * 1024;
        case 'MiB':
            return p1 * 1024 * 1024;
        case 'GiB':
            return p1 * 1024 * 1024;
        default:
            return p1;
    }
}
argv.forEach((f, index) => {
  if(f === '--manager' || f === '-m') {
    managerConfig = argv[index + 1];
  }
  if(f === '--gateway' || f === '-g') {
    gateway = argv[index + 1];
  }
  if(f === '--interface' || f === '-i') {
    interface = argv[index + 1];
  }
});
const mPort = +managerConfig.split(':')[1];
client.bind(mPort);

let lastFlow;

const runCommand = async cmd => {
  return new Promise((resolve, reject) => {
    exec(cmd, async (err, stdout, stderr) => {
      if(err) {
	console.error("bad things happened!");
        console.error(err);
        return reject(stderr);
      } else {
        return resolve(stdout);
      }
    });
  });
};

const sendAddMessage = async (port, password) => {
  console.log('add: ' + password.trim());
  const a = port % 254;
  const b = (port - a) / 254;
  await runCommand(`tunsafe set ${ interface } peer ${ password.trim() } allowed-ips ${ gateway.split('.')[0] }.${ gateway.split('.')[1] }.${ b }.${ a + 1 }/32`);
  return Promise.resolve('ok');
};

const sendDelMessage = async (port, password) => {
  if(password) {
    console.log('del: ' + password);
    await runCommand(`tunsafe set ${ interface } peer ${ password } remove`);
    return Promise.resolve('ok');
  }
  const accounts = await db.listAccountObj();
  console.log('del: ' + accounts[port]);
  await runCommand(`tunsafe set ${ interface } peer ${ accounts[port] } remove`);
  return Promise.resolve('ok');
};

let existPort = [];
let existPortUpdatedAt = Date.now();
const setExistPort = flow => {
  existPort = [];
  if(Array.isArray(flow)) {
    existPort = flow.map(f => +f.server_port);
  } else {
    for(const f in flow) {
      existPort.push(+f);
    }
  }
  existPortUpdatedAt = Date.now();
};

const compareWithLastFlow = (flow, lastFlow) => {
  const realFlow = [];
  if(!lastFlow) {
    return flow.map(m => {
      return { port: m.port, flow: m.flow };
    }).filter(f => f.flow > 0);
  }
  for(const f of flow) {
    const last = lastFlow.filter(la => la.port === f.port)[0];
    if(last && f.flow - last.flow >= 0) {
      realFlow.push({
        port: f.port,
        flow: f.flow - last.flow,
      })
    } else {
      realFlow.push({
        port: f.port,
        flow: f.flow,
      });
    }
  }
  return realFlow.filter(f => f.flow > 0);;
};

let firstFlow = true;

const startUp = async () => {
  const result = await runCommand(`tunsafe show ${ interface }`);
  const peers = result.split('peer: ').filter(f => f).map(m => {
   // const data = m.split('peer: ');
    return m.substring(0,44);
  });
  peers.shift();
  const accounts = await db.listAccount();
  for(const account of accounts) {
    if(!peers.includes(account.password)) {
      await sendAddMessage(account.port, account.password);
    }
  }
};

const resend = async () => {
  const result = await runCommand(`tunsafe show ${ interface } transfer`);
    const peers = result.split('peer: ').filter(f => f).map(m => {
        const aparse = m.split(/\r?\n/);
        const transfer = aparse[3].substring(13).split(' ');
        const recieved = toMib(transfer[0], transfer[1]);
        const send = toMib(transfer[3], transfer[4]);
        //const data = m.split('\t');
	if (isNaN(send)) send=0;
	if (isNaN(recieved)) recieved=0;
        return {
            key: m.substring(0,44),
        flow: (+recieved) + (+send),
    };
  });
	peers.shift();
  const accounts = await db.listAccount();
  for(const account of accounts) {
    if(!peers.map(m => m.key).includes(account.password)) {
      await sendAddMessage(account.port, account.password);
    }
  }
  for(const peer of peers) {
    if(!accounts.map(m => m.password).includes(peer.key)) {
      await sendDelMessage(null, peer.key);
    } else {
      peer.port = accounts.filter(f => f.password === peer.key)[0].port;
    }
  }
  const peersWithPort = peers.filter(f => f.port);
  const realFlow = compareWithLastFlow(peersWithPort, lastFlow);
  lastFlow = peersWithPort;
  const insertFlow = realFlow.map(m => {
    return {
      port: +m.port,
      flow: +m.flow,
      time: Date.now(),
    };
  }).filter(f => {
    return f.flow > 0;
  });

  if(insertFlow.length > 0) {
    if(firstFlow) {
      firstFlow = false;
    } else {
      for(let i = 0; i < Math.ceil(insertFlow.length/50); i++) {
        await db.insertFlow(insertFlow.slice(i * 50, i * 50 + 50));
      }
    }
  }
};

let isGfw = 0;
let getGfwStatusTime = null;
const getGfwStatus = () => {
  if(getGfwStatusTime && isGfw === 0 && Date.now() - getGfwStatusTime < 600 * 1000) { return; }
  getGfwStatusTime = Date.now();
  const sites = [
    'baidu.com:80',
  ];
  const site = sites[0];
  // const site = sites[+Math.random().toString().substr(2) % sites.length];
  const req = http.request({
    hostname: site.split(':')[0],
    port: +site.split(':')[1],
    path: '/',
    method: 'GET',
    timeout: 2000,
  }, res => {
    if(res.statusCode === 200) {
      isGfw = 0;
    }
    res.setEncoding('utf8');
    res.on('data', (chunk) => {});
    res.on('end', () => {});
  });
  req.on('timeout', () => {
    req.abort();
    isGfw += 1;
  });
  req.on('error', (e) => {
    isGfw += 1;
  });
  req.end();
};

startUp();
setInterval(() => {
  resend();
  getGfwStatus();
}, 60 * 1000);

const addAccount = (port, password) => {
  return db.addAccount(port, password).then(success => {
    sendAddMessage(port, password);
  }).then(() => {
    return { port, password };
  });
};

const removeAccount = async port => {
  const password = await db.listAccountObj().then(s => s[port]);
  await db.removeAccount(port);
  await sendDelMessage(port, password);
  return { port };
};

const changePassword = (port, password) => {
  return db.updateAccount(port, password).then(() => {
    return sendDelMessage(port);
  }).then(() => {
    return sendAddMessage(port, password);
  }).then(() => {
    return { port };
  });
};

const listAccount = () => {
  return Promise.resolve(db.listAccount());
};

const getFlow = (options) => {
  const startTime = options.startTime || 0;
  const endTime = options.endTime || Date.now();
  return db.getFlow(options);
};

const getVersion = () => {
  return Promise.resolve({
    version: version + 'W',
    isGfw: !!(isGfw > 5),
  });
};

const getClientIp = async port => {
  const accounts = await db.listAccountObj();
  const account = accounts[port];
  if(!account) {
    return [];
  }
    const result = await runCommand(`tunsafe show ${interface }`);
    var client = result.split('peer: ');
    var accountdata = client[client.findIndex((acc) => { return acc.startsWith(account); }, account)];
    var accountParse = accountdata.split(/\r?\n/);

    var ip = accountParse[1].substring(15, accountParse[1].indexOf('/'));
    /*
  const client = result.split(/\s/)[2];
  if(client.trim() === '(none)') {
    return Promise.resolve([]);
  }
  */
  return Promise.resolve([ ip ]);
};

exports.addAccount = addAccount;
exports.removeAccount = removeAccount;
exports.changePassword = changePassword;
exports.listAccount = listAccount;
exports.getFlow = getFlow;
exports.getVersion = getVersion;
exports.getClientIp = getClientIp;

