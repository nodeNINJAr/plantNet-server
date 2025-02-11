require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const jwt = require('jsonwebtoken')
const morgan = require('morgan');
const nodemailer = require("nodemailer");
const stripe = require('stripe')(process.env.STRIPE_PAYMENT_SECRET);
// 
const port = process.env.PORT || 5000
const app = express()
// middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174','https://plantnet-3f481.web.app', 'https://plantnet-3f481.firebaseapp.com'],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions))

app.use(express.json())
app.use(cookieParser())
app.use(morgan('dev'))

const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token

  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: 'unauthorized access' })
    }
    req.user = decoded;
    next()
  })
}


// email sender by node mailer 1st perameter is email reciver and 2nd perameter is email data
const sendMail= (emailAddress, emailData)=>{
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // true for port 465, false for other ports
    auth: {
      user:process.env.NODE_MAILER_EMAIL,
      pass:process.env.NODE_MAILER_PASS,
    },
  });
  // for verify connection user transporter is work or not for this user
  transporter.verify((err, success)=>{
    if(err){
       console.log(err);
    }
    else{
      console.log('transporter is ready to send email', success);
    }
  })

  // send mail with defined transport object
 const mailBody = {
    from: process.env.NODE_MAILER_EMAIL, // sender address
    to:emailAddress , // list of receivers
    subject: emailData?.subject, // Subject line
    html:`<p>${emailData?.message}</p>` // html body
  };
// send the mail
  transporter.sendMail(mailBody,(err, info)=>{
      if(err){
        console.log(err);
      }
      else{
        console.log('Email Sent : +' + info?.response);
      }
  } )
}
// 

// 
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pm9ea.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})

async function run() {
  try {
   
     const db = client.db('plantNet')
     const plantsCollection = db.collection('plants')
     const usersCollection = db.collection('users');
     const orderedCollection = db.collection('orderedPlants');


    // veryfy admin middleware
    const verifyAdmin = async(req,res,next)=>{
      const verifiedEmail = req.user.email;
      const query = {
        userEmail:verifiedEmail,
      }
      const user = await usersCollection.findOne(query)
      // 
      if(!user || user.role !== "admin"){
          return res.status(403).send('Forbidden Access')
      }
      next()
    }

    // veryfy seller middleware
    const verifySeller = async(req,res,next)=>{
      const verifiedEmail = req.user.email;
      const query = {
        userEmail:verifiedEmail,
      }
      const user = await usersCollection.findOne(query)
      // 
      if(!user || user.role !== "seller"){
          return res.status(403).send('Forbidden Access')
      }
      next()
    }



    // save and update user in db
    app.post("/users/:email", async(req,res)=>{
        const email = req.params.email;
        const query ={userEmail:email}
        const user = req.body;
        // isExist
        const isExist = await usersCollection.findOne(query)
         if(isExist){
            return res.send(isExist)
         }

         const result = await usersCollection.insertOne({...user,userEmail:email,  role: "customer", timeStamp : Date.now(),});
         res.send(result)
    })



    // add plants
    app.post('/plants',verifyToken,verifySeller, async (req,res)=>{
       const plant = req.body;
       const result = await plantsCollection.insertOne(plant);
       res.send(result)
    })

    // add ordered plant
    app.post('/order' ,verifyToken, async(req,res)=>{
      const orderedPlant = req.body;
      const result = await orderedCollection.insertOne(orderedPlant);
      if(result?.insertedId){
        // to customer
        sendMail(orderedPlant?.coustomer?.email, {
          subject:'Order Comfermation',
          message:`Your Order Success Your transaction Id is ${result?.insertedId}`
        })
        //to seller
        sendMail(orderedPlant?.sellerEmail,{
          subject:"Your products ordered",
          message:`Your product Successfully orderd by ${orderedPlant?.coustomer?.name}`
        })
      }
      res.send(result)
    })

    // create payment intent
    app.post('/create-payment-intent',verifyToken, async(req, res)=>{
        const {productId, quantity} = req.body;
        const plant= await plantsCollection.findOne({_id: new ObjectId(productId)});
        if(!plant){
          return res.status(404).send({message:"Not found"});
        }
        const totalPrice = quantity * plant?.price *100 //make dollor to send
        //  
        const {client_secret} = await stripe.paymentIntents.create({
          amount: totalPrice,
          currency: 'usd',
          automatic_payment_methods: {
            enabled: true,
          },
        });

        res.send({client_secret})
    })









// update plant quantity
app.patch('/plants/quantity/:id',verifyToken, async(req,res)=>{
    const id = req.params.id;
    const {quantityToUpdate, status} = req.body;
    // 
    const filter ={ _id: new ObjectId(id)};

    let updateQuantity={
       $inc:{
        quantity: - quantityToUpdate
       }
    }

    if(status === 'increase'){
     updateQuantity={
        $inc:{
         quantity: quantityToUpdate
        }
     }  
    }
    const result = await plantsCollection.updateOne(filter , updateQuantity );
    res.send(result)
})

// set user role update request on usercollection
app.patch('/users/:email',verifyToken, async(req,res)=>{
   const email = req.params.email;
   const query= {userEmail:email };
   const user = await usersCollection.findOne(query);
   if(!user || user?.status === "requested") return res.status(400).send('You already requested , wait for some time');
    const updateRole = {
      $set:{
       status: 'requested',
      }
    }
    const result = await usersCollection.updateOne(query, updateRole);
    res.send(result)
})
// update user role by admin
app.patch('/user/role/:email',verifyToken, verifyAdmin, async(req,res)=>{
   const email = req.params.email;
   const{ role} = req.body;
   const filter = {
      userEmail:email,
   }
   const updatedRole ={
      $set:{role, status:"verified"}
   }
   const result = await usersCollection.updateOne(filter, updatedRole);
   res.send(result)
})

// update order status by seller 
app.patch('/manage-order/status/:id',verifyToken,verifySeller, async(req,res)=>{
  const id = req.params.id;
  const status = req.body;
  const query = {_id: new ObjectId(id) };
  //  
   const updateStatus = {
     $set:{
      status: status?.setStatus,
     }
   }
   const result = await orderedCollection.updateOne(query, updateStatus);
   res.send(result)
})




  // get all plants
  app.get('/plants', async (req,res)=>{
    const result = await plantsCollection.find().toArray()
     res.send(result)
 })
  // get plant by id
  app.get("/plants/:id" , async(req, res)=>{
    const id = req.params.id;
    const query = {_id : new ObjectId(id)};
    const result = await plantsCollection.findOne(query);
    res.status(200).send(result);
})


   // get specific user order data by email by aggregate
   app.get('/customer-order/:email' ,verifyToken, async(req,res)=>{
    const email = req.params.email;
   
   // by aggregate for add data from multiple collection
   const result = await orderedCollection.aggregate([
    // pipeline
      {
        // match with the query
        $match: {'customer.email' : email} ,
      },
      {
        // string to convert obj id
        $addFields:{   
          productId : {$toObjectId : '$productId' }
        },
      },
      // lookup (visit one collection to another collection)
      {
        $lookup :{
             //where we want to look up (collection) 
             from:'plants',
            //  order collection id
             localField:'productId',
            // plants collection id
             foreignField:'_id',
             // name of the new array is get with order collection (usally is provided an array)
             as:'plants'
        },
      },
      // data in obj instance of array
      {
        $unwind : '$plants'
      },
      // for get some data from unwind obj and add to order product array , (like key:value)
      {
        $addFields: {
          plantName:'$plants.name',
          plantImage:'$plants.image',
          plantCategory:'$plants.category'
        },
      },
      // to remove un used plants obj 
      {
        $project:{
          plants:0, // this value is 1 or 0 ( if is 1 (plants:1) is just call plants and other all value is removed, 0 for remove the just plants key from the obj)
          // name:1, we can not write like this is used 1 just one or 0 just 0
          //we can call object item like this ...thats whats we need,
        },
      }

  ]).toArray()

  res.send(result);
  })


// manage user order by seller using aggregrate
app.get('/manage-order/:email',verifyToken,verifySeller, async(req,res)=>{
   const email = req.params.email;
   const result = await orderedCollection.aggregate([
     //pipeline
     {   
      $match:{ 
      sellerEmail:email}
     },
     {
      $addFields:{   
         productId:{$toObjectId:'$productId'}
      }
     },
     {
      $lookup:{
        from:"plants",
        localField:"productId",
        foreignField:"_id",
        as:"orders",
      }
     },
     {
      $unwind:'$orders'
     },
     {
       $addFields:{
         plantName:'$orders.name'
       }
     },
      {
        $project:{
            orders:0,
        }
      }
    
   ]).toArray()
 res.send(result)
})

// admin stats
app.get('/stats',verifyToken,verifyAdmin, async (req,res)=>{
// 
   const totalPlant = await plantsCollection.estimatedDocumentCount();
   const totalUser = await usersCollection.estimatedDocumentCount();
   const orderDetails = await orderedCollection.aggregate([
       {
         $group:{
          _id:null,
          totalRevenue:{$sum: "$price"},
          totalOrders:{$sum:1}
         }
       },
       {
        $project:{
          _id:0,
        }
       }
   ]).next();
  //  

  const chartData = await orderedCollection.aggregate([
    {
      $sort:{
        _id:-1,
      }
    },
    {
      $addFields:{
        _id:{
          $dateToString:{
            format:'%Y-%m-%d',
            date:{$toDate:'$_id'}
          },
        },
        quantity:{
           $sum:"$quantity",
        },
        price:{$sum:"$price"},
        order:{$sum:1}
      }
    },
    {
      $project:{
       _id:0,
       date:'$_id',
       quantity:1,
       price:1,
       order:1,
    }
  }
  ]).toArray()

   res.send({totalPlant,totalUser,...orderDetails,chartData})

})







// get user role api
app.get('/user/role/:email',verifyToken, async (req,res)=>{
   const email= req.params.email;
   const query = { 
      userEmail:email,
   }
   const user = await usersCollection.findOne(query)
  //  if(!user || !user?.role === "admin"){
  //     return res.status(403).send({message:"Forvidden Access"})
  //  }
  res.send({role:user?.role})
})
//get all user api
app.get('/users/:email',verifyToken,verifyAdmin, async(req,res)=>{
   const email = req.params.email;
  //  $ne: operator for find all data without query
   const query = {
       userEmail:{$ne:email}
   }
  const result = await usersCollection.find(query).toArray();
  res.send(result)
})


// get all seller product
app.get('/seller/plants',verifyToken,verifySeller, async(req,res)=>{
   const email = req?.user?.email;
   const result = await plantsCollection.find({'seller.email':email}).toArray();
   res.send(result)
})

// added plant delete by seller
app.delete('/plants/:id', async (req, res)=>{
    const id = req.params.id;
    const query = {
        _id: new ObjectId(id),
    }
    const result = await plantsCollection.deleteOne(query);
    res.send(result)
})



  // Remove plants by Seller
  app.delete('/manage-order/:id',verifyToken,verifySeller, async(req, res)=>{
    const id = req.params.id;
    const query = {
        _id: new ObjectId(id)
    };
    const delivered = await orderedCollection.findOne(query);
    if(delivered.status === "delivered") return res.status(409).send("You Cannot cancle a deliverd product")
  const result = await orderedCollection.deleteOne(query);
  res.status(200).send(result)
  })


    //order cancled by user
    app.delete('/order-cancle/:id',verifyToken, async(req, res)=>{
      const id = req.params.id;
      const query = {
          _id: new ObjectId(id)
      };
    const delivered = await orderedCollection.findOne(query);
    if(delivered.status === "delivered") return res.status(409).send("You Cannot cancle a deliverd product")
    const result = await orderedCollection.deleteOne(query);
    res.status(200).send(result)
    })

    // Generate jwt token
    app.post('/jwt', async (req, res) => {
      const email = req.body
      const token = jwt.sign(email, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '365d',
      })
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        })
        .send({ success: true })
    })
    // Logout
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
          })
          .send({ success: true })
      } catch (err) {
        res.status(500).send(err)
      }
    })

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    // console.log(
    //   'Pinged your deployment. You successfully connected to MongoDB!'
    // )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from plantNet Server..')
})

app.listen(port, () => {
  console.log(`plantNet is running on port ${port}`)
})
