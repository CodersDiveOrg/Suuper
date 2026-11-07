import { Module } from "@nestjs/common";
import {
  BusinessInvitationsController,
  InvitationsController,
} from "./invitations.controller";
import { InvitationsService } from "./invitations.service";

@Module({
  controllers: [BusinessInvitationsController, InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
