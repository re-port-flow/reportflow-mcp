import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: [], // 只显示错误和警告
  });
  await app.listen(process.env.PORT ?? 3030);
}
void bootstrap();
