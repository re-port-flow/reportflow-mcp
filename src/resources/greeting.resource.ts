import { Injectable, Scope } from '@nestjs/common';
import { Resource } from '@/mcp';

@Injectable({ scope: Scope.REQUEST })
export class GreetingResource {
  constructor() {}

  @Resource({
    name: 'hello-world',
    description: 'A simple greeting resource',
    mimeType: 'text/plain',
    uri: 'mcp://hello-world/{name}',
  })
  sayHello({ name }) {
    return {
      contents: [
        {
          uri: 'mcp://hello-world',
          mimeType: 'text/plain',
          text: `Hello ${name}`,
        },
      ],
    };
  }
}
