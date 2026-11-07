import { Module } from "@nestjs/common";
import { BusinessesModule } from "../businesses/businesses.module";
import { InvitationsModule } from "../invitations/invitations.module";
import { AgenciesController, BrandingController } from "./agencies.controller";
import { AgenciesService } from "./agencies.service";

@Module({
  imports: [BusinessesModule, InvitationsModule],
  controllers: [AgenciesController, BrandingController],
  providers: [AgenciesService],
})
export class AgenciesModule {}
