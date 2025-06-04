import { Member } from '@/application/gateways/model/member.model';
import { Column, Entity, OneToMany, OneToOne, PrimaryColumn } from 'typeorm';
import { Design } from '@/application/gateways/model/design.model';
import { ulid } from 'ulid';
import { ApplicationToken } from '@/application/gateways/model/application.token.model';
import { UserType } from '@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0';
import { WorkspacePlan } from '@/application/gateways/model/workspace_plan.model';
import { WorkspaceEntity } from '@/application/domain/entity';
import { PaymentModel } from '@/application/gateways/model/payment.model';

@Entity('m_workspace')
export class Workspace {
  @PrimaryColumn({
    default: ulid(),
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    name: 'name',
    type: 'varchar',
    length: 80,
  })
  name: string;

  @Column({
    name: 'overview',
    type: 'mediumtext',
    nullable: true,
  })
  overview: string;

  @Column({
    name: 'icon',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  icon: string;

  @Column({
    name: 'stripe_customer_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeCustomerId?: string;

  @Column({
    name: 'create_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    foreignKeyConstraintName: 'create_user_cd',
  })
  createUserCd: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  })
  updatedAt: Date;

  @Column({
    name: 'delete_flag',
    type: 'boolean',
    default: false,
  })
  deleteFlag: boolean;

  @Column({
    name: 'update_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    foreignKeyConstraintName: 'update_user_cd',
  })
  updateUserCd: string;

  @OneToMany(() => Member, (member) => member.workspace)
  members: Member[];

  @OneToMany(() => Design, (design) => design.workspace)
  designs: Design[];

  @OneToOne(
    () => ApplicationToken,
    (applicationToken) => applicationToken.workspace,
  )
  applicationToken: ApplicationToken;

  @OneToMany(() => PaymentModel, (payment) => payment.workspace)
  payment: PaymentModel;

  @OneToMany(() => WorkspacePlan, (plan) => plan.workspace)
  workspacePlan: WorkspacePlan[];

  toEntity(users?: UserType[]): WorkspaceEntity {
    return {
      id: this.id,
      name: this.name,
      overview: this.overview,
      icon: this.icon,
      stripeCustomerId: this.stripeCustomerId,
      applicationToken: this.applicationToken
        ? {
            token: this.applicationToken.applicationKey,
            secretToken: this.applicationToken.secretKey,
          }
        : undefined,
      members:
        this.members?.map((member) =>
          member.toEntity(users?.find((u) => u.Username === member.userId)),
        ) ?? [],
      workspacePlan:
        this.workspacePlan?.length > 0
          ? this.workspacePlan[0].toEntity()
          : undefined,
    };
  }
}
