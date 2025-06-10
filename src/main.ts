import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  return app.close();
}
void bootstrap();

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule, {
//     logger: ['debug'],
//   });
//   await app.listen(3030);
// }
//
// void bootstrap();
