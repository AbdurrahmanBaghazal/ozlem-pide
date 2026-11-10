import { server } from './vercel-server.mjs';

server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
