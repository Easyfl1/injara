import { prisma } from "../src/db/prisma.js";

async function seed() {
  const treasury = await prisma.treasuryState.findUnique({ where: { id: 1 } });
  if (!treasury) {
    await prisma.treasuryState.create({
      data: {
        id: 1,
        walletAddress: process.env.TREASURY_INJ_ADDRESS ?? "",
        onchainInjBase: "0",
        reservedInjBase: "0",
        gasBufferInjBase: "50000000000000000",
        flwAvailableNgnKobo: 0n,
        reservedNgnKobo: 0n,
        lastSyncedAt: new Date(),
      },
    });
    console.log("Treasury state seeded");
  }

  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
